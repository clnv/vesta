package server

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/vesta-explorer/vesta/internal/auth"
	"github.com/vesta-explorer/vesta/internal/logsql"
	"github.com/vesta-explorer/vesta/internal/victoria"
)

type streamEvent struct {
	Type                    string         `json:"type"`
	RequestID               string         `json:"requestId,omitempty"`
	Row                     map[string]any `json:"row,omitempty"`
	Status                  string         `json:"status,omitempty"`
	Reason                  string         `json:"reason,omitempty"`
	Message                 string         `json:"message,omitempty"`
	Rows                    int            `json:"rows,omitempty"`
	Bytes                   int64          `json:"bytes,omitempty"`
	ElapsedMs               int64          `json:"elapsedMs,omitempty"`
	VictoriaDurationSeconds string         `json:"victoriaDurationSeconds,omitempty"`
	Warning                 string         `json:"warning,omitempty"`
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	input, ok := decodeQueryRequest(w, r)
	if !ok {
		return
	}
	input.Query = logsql.WithoutRenderOperator(input.Query)
	if !logsql.HasTimeFilter(input.Query) {
		writeJSONError(w, http.StatusUnprocessableEntity, "LogsQL query must contain an explicit _time: filter")
		return
	}
	user := auth.MustUser(r.Context())
	source, allowed := s.authorize(user, input)
	if !allowed {
		writeJSONError(w, http.StatusForbidden, "source is not available to this account")
		return
	}
	if !s.gate.acquire(user.Subject) {
		writeJSONError(w, http.StatusTooManyRequests, "concurrent query limit reached")
		return
	}
	defer s.gate.release(user.Subject)

	requestID := newRequestID()
	started := time.Now()
	upstreamCtx, cancel := context.WithTimeout(r.Context(), s.cfg.Limits.QueryTimeout.Duration)
	defer cancel()
	s.metrics.queries.Add(1)
	s.metrics.active.Add(1)
	defer s.metrics.active.Add(-1)

	resultSource := source
	resultSource.HiddenFields = append(append([]string{}, source.HiddenFields...), user.HiddenResultFields...)
	response, err := s.vlogs.Do(upstreamCtx, victoria.Request{Source: resultSource, Endpoint: "/select/logsql/query", Query: input.Query})
	if err != nil {
		s.metrics.errors.Add(1)
		status := http.StatusBadGateway
		message := "VictoriaLogs is unavailable"
		if errors.Is(err, context.DeadlineExceeded) {
			status, message = http.StatusGatewayTimeout, "query timed out before VictoriaLogs responded"
		}
		writeJSONError(w, status, message)
		s.logCompletion(user, source.ID, requestID, started, "error", 0, 0, err)
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		s.metrics.errors.Add(1)
		message := victoria.ReadError(response)
		writeJSONError(w, http.StatusBadGateway, message)
		s.logCompletion(user, source.ID, requestID, started, "error", 0, 0, fmt.Errorf("upstream status %d", response.StatusCode))
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "streaming is unsupported")
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	encoder := json.NewEncoder(w)
	warning := ""
	if logsql.LooksUnbounded(input.Query) {
		warning = "This _time filter may scan an unbounded or recurring range."
	}
	_ = encoder.Encode(streamEvent{Type: "meta", RequestID: requestID, Warning: warning})
	flusher.Flush()

	rows, bytesRead := 0, int64(0)
	status, reason := "complete", ""
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64<<10), s.cfg.Limits.MaxLineBytes)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		if rows >= s.cfg.Limits.MaxRows || bytesRead+int64(len(line)) > s.cfg.Limits.MaxBytes {
			status, reason = "truncated", "viewer safety limit reached; narrow the query or add an explicit LogsQL limit"
			s.metrics.truncated.Add(1)
			cancel()
			break
		}
		var row map[string]any
		if err := json.Unmarshal(line, &row); err != nil {
			status, reason = "error", "VictoriaLogs returned a malformed JSON row"
			s.metrics.errors.Add(1)
			cancel()
			break
		}
		redactHiddenFields(row, resultSource.HiddenFields)
		rows++
		bytesRead += int64(len(line))
		if err := encoder.Encode(streamEvent{Type: "row", Row: row}); err != nil {
			cancel()
			return
		}
		flusher.Flush()
	}
	if err := scanner.Err(); err != nil && status == "complete" {
		switch {
		case errors.Is(upstreamCtx.Err(), context.DeadlineExceeded):
			status, reason = "truncated", "query exceeded the configured execution timeout"
			s.metrics.truncated.Add(1)
		case errors.Is(upstreamCtx.Err(), context.Canceled) && r.Context().Err() != nil:
			return
		default:
			status, reason = "error", "VictoriaLogs stream ended unexpectedly"
			s.metrics.errors.Add(1)
		}
	}
	s.metrics.rows.Add(int64(rows))
	s.metrics.bytes.Add(bytesRead)
	_ = encoder.Encode(streamEvent{
		Type: "end", RequestID: requestID, Status: status, Reason: reason,
		Rows: rows, Bytes: bytesRead, ElapsedMs: time.Since(started).Milliseconds(),
		VictoriaDurationSeconds: response.Header.Get("VL-Request-Duration-Seconds"),
	})
	flusher.Flush()
	s.logCompletion(user, source.ID, requestID, started, status, rows, bytesRead, nil)
}

func (s *Server) handleMetadata(w http.ResponseWriter, r *http.Request, values bool) {
	input, ok := decodeQueryRequest(w, r)
	if !ok {
		return
	}
	input.Query = logsql.WithoutRenderOperator(input.Query)
	if !logsql.HasTimeFilter(input.Query) {
		writeJSONError(w, http.StatusUnprocessableEntity, "LogsQL query must contain an explicit _time: filter")
		return
	}
	if values && strings.TrimSpace(input.Field) == "" {
		writeJSONError(w, http.StatusBadRequest, "field is required")
		return
	}
	user := auth.MustUser(r.Context())
	source, allowed := s.authorize(user, input)
	if !allowed {
		writeJSONError(w, http.StatusForbidden, "source is not available to this account")
		return
	}
	if values && hiddenField(input.Field, source.HiddenFields) {
		writeJSONError(w, http.StatusForbidden, "field is hidden by source policy")
		return
	}
	endpoint := "/select/logsql/field_names"
	if values {
		endpoint = "/select/logsql/field_values"
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.Limits.QueryTimeout.Duration)
	defer cancel()
	response, err := s.vlogs.Do(ctx, victoria.Request{Source: source, Endpoint: endpoint, Query: input.Query, Field: input.Field})
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "VictoriaLogs metadata request failed")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeJSONError(w, http.StatusBadGateway, victoria.ReadError(response))
		return
	}
	contents, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "VictoriaLogs metadata response could not be read")
		return
	}
	if len(contents) > 2<<20 {
		writeJSONError(w, http.StatusBadGateway, "VictoriaLogs metadata response exceeded the safety limit")
		return
	}
	var payload any
	if err := json.Unmarshal(contents, &payload); err != nil {
		writeJSONError(w, http.StatusBadGateway, "VictoriaLogs metadata response was malformed")
		return
	}
	if values {
		redactHiddenFields(payload, source.HiddenFields)
	} else {
		filterHiddenFieldNames(payload, source.HiddenFields)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(payload)
}

func hiddenField(field string, patterns []string) bool {
	for _, pattern := range patterns {
		if strings.HasSuffix(pattern, "*") && strings.HasPrefix(field, strings.TrimSuffix(pattern, "*")) || field == pattern {
			return true
		}
	}
	return false
}

func redactHiddenFields(value any, patterns []string) {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if hiddenField(key, patterns) {
				delete(typed, key)
				continue
			}
			redactHiddenFields(child, patterns)
		}
	case []any:
		for _, child := range typed {
			redactHiddenFields(child, patterns)
		}
	}
}

func filterHiddenFieldNames(value any, patterns []string) {
	object, ok := value.(map[string]any)
	if !ok {
		return
	}
	values, ok := object["values"].([]any)
	if !ok {
		return
	}
	filtered := values[:0]
	for _, item := range values {
		name, isString := item.(string)
		if entry, isObject := item.(map[string]any); isObject {
			name, _ = entry["value"].(string)
		}
		if (isString || name != "") && hiddenField(name, patterns) {
			continue
		}
		filtered = append(filtered, item)
	}
	object["values"] = filtered
}

func (s *Server) logCompletion(user auth.User, sourceID, requestID string, started time.Time, status string, rows int, bytes int64, err error) {
	attributes := []any{
		"request_id", requestID, "subject", user.Subject, "source_id", sourceID,
		"status", status, "duration_ms", time.Since(started).Milliseconds(), "rows", rows, "bytes", bytes,
	}
	if err != nil {
		attributes = append(attributes, "error", err)
	}
	s.logger.Info("VictoriaLogs request completed", attributes...)
}

func newRequestID() string {
	bytes := make([]byte, 12)
	if _, err := rand.Read(bytes); err != nil {
		return fmt.Sprintf("fallback-%d", time.Now().UnixNano())
	}
	return base64.RawURLEncoding.EncodeToString(bytes)
}
