package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vesta-explorer/vesta/internal/auth"
	"github.com/vesta-explorer/vesta/internal/config"
	"github.com/vesta-explorer/vesta/internal/victoria"
)

type upstreamCapture struct {
	mu      sync.Mutex
	form    url.Values
	headers http.Header
	calls   int
}

func testHandler(t *testing.T, upstreamURL string, limits config.LimitsConfig) http.Handler {
	t.Helper()
	cfg := &config.Config{
		Server: config.ServerConfig{ExternalURL: "http://vesta.example.test"},
		Auth: config.AuthConfig{
			DevMode:    true,
			DevUser:    config.DevUserConfig{Subject: "tester", Email: "tester@example.test", Name: "Tester", Roles: []string{"reader"}},
			SessionTTL: config.Duration{Duration: time.Hour},
		},
		Limits: limits,
		Sources: []config.SourceConfig{{
			ID: "prod", Name: "Production", URL: upstreamURL, Roles: []string{"reader"},
			Tenants:      []config.Tenant{{AccountID: "12", ProjectID: "34", Name: "payments"}},
			HiddenFields: []string{"password*", "authorization"},
		}},
	}
	if cfg.Limits.QueryTimeout.Duration == 0 {
		cfg.Limits.QueryTimeout.Duration = time.Second
	}
	if cfg.Limits.MaxRows == 0 {
		cfg.Limits.MaxRows = 50_000
	}
	if cfg.Limits.MaxBytes == 0 {
		cfg.Limits.MaxBytes = 32 << 20
	}
	if cfg.Limits.MaxQueriesPerUser == 0 {
		cfg.Limits.MaxQueriesPerUser = 4
	}
	if cfg.Limits.MaxTailsPerUser == 0 {
		cfg.Limits.MaxTailsPerUser = 2
	}
	if cfg.Limits.MaxLineBytes == 0 {
		cfg.Limits.MaxLineBytes = 8 << 20
	}
	authenticator, err := auth.New(context.Background(), cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return New(cfg, authenticator, victoria.NewClient(), slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func queryBody(query string) io.Reader {
	value, _ := json.Marshal(map[string]any{
		"sourceId": "prod",
		"tenant":   map[string]string{"accountId": "12", "projectId": "34"},
		"query":    query,
	})
	return bytes.NewReader(value)
}

func TestQueryForwardsOnlyQuerySemantics(t *testing.T) {
	capture := &upstreamCapture{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		capture.mu.Lock()
		capture.calls++
		capture.form = r.PostForm
		capture.headers = r.Header.Clone()
		capture.mu.Unlock()
		w.Header().Set("VL-Request-Duration-Seconds", "0.004")
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = io.WriteString(w, "{\"_time\":\"2026-07-22T12:00:00Z\",\"_msg\":\"one\",\"password_hash\":\"secret\"}\n{\"_time\":\"2026-07-22T12:00:01Z\",\"_msg\":\"two\"}\n")
	}))
	defer upstream.Close()

	handler := testHandler(t, upstream.URL, config.LimitsConfig{})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h error | limit 2"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	capture.mu.Lock()
	defer capture.mu.Unlock()
	if capture.calls != 1 {
		t.Fatalf("upstream calls = %d", capture.calls)
	}
	if got := capture.form.Get("query"); got != "_time:1h error | limit 2" {
		t.Fatalf("query = %q", got)
	}
	for _, forbidden := range []string{"start", "end", "limit", "offset", "extra_filters"} {
		if capture.form.Has(forbidden) {
			t.Fatalf("unexpected upstream parameter %q", forbidden)
		}
	}
	if len(capture.form) != 2 || capture.form.Get("hidden_fields_filters") != `["password*","authorization"]` {
		t.Fatalf("normal query form contains unexpected semantics: %v", capture.form)
	}
	if capture.headers.Get("AccountID") != "12" || capture.headers.Get("ProjectID") != "34" {
		t.Fatal("tenant headers were not forwarded")
	}

	var events []streamEvent
	scanner := bufio.NewScanner(strings.NewReader(recorder.Body.String()))
	for scanner.Scan() {
		var event streamEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	if len(events) != 4 || events[0].Type != "meta" || events[1].Type != "row" || events[3].Status != "complete" {
		t.Fatalf("unexpected events: %#v", events)
	}
	if _, leaked := events[1].Row["password_hash"]; leaked {
		t.Fatal("hidden field reached the browser")
	}
}

func TestMalformedAndPartialUpstreamRows(t *testing.T) {
	t.Run("partial line is assembled", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, "{\"_time\":\"1\",")
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			_, _ = io.WriteString(w, "\"_msg\":\"complete\"}\n")
		}))
		defer upstream.Close()
		handler := testHandler(t, upstream.URL, config.LimitsConfig{})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h"))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if !strings.Contains(recorder.Body.String(), `"_msg":"complete"`) || !strings.Contains(recorder.Body.String(), `"status":"complete"`) {
			t.Fatalf("partial row was not streamed correctly: %s", recorder.Body.String())
		}
	})

	t.Run("malformed row becomes terminal error", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, "{not-json}\n")
		}))
		defer upstream.Close()
		handler := testHandler(t, upstream.URL, config.LimitsConfig{})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h"))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if !strings.Contains(recorder.Body.String(), `"status":"error"`) || !strings.Contains(recorder.Body.String(), "malformed JSON row") {
			t.Fatalf("malformed row was not reported: %s", recorder.Body.String())
		}
	})
}

func TestTimeoutAndClientCancellationStopUpstream(t *testing.T) {
	t.Run("execution timeout is visible", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		}))
		defer upstream.Close()
		handler := testHandler(t, upstream.URL, config.LimitsConfig{QueryTimeout: config.Duration{Duration: 25 * time.Millisecond}})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h"))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if !strings.Contains(recorder.Body.String(), `"status":"truncated"`) || !strings.Contains(recorder.Body.String(), "execution timeout") {
			t.Fatalf("timeout was not visible: %s", recorder.Body.String())
		}
	})

	t.Run("client cancellation reaches upstream", func(t *testing.T) {
		started := make(chan struct{})
		cancelled := make(chan struct{})
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			close(started)
			<-r.Context().Done()
			close(cancelled)
		}))
		defer upstream.Close()
		handler := testHandler(t, upstream.URL, config.LimitsConfig{QueryTimeout: config.Duration{Duration: time.Second}})
		ctx, cancel := context.WithCancel(context.Background())
		req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h")).WithContext(ctx)
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		done := make(chan struct{})
		go func() {
			handler.ServeHTTP(recorder, req)
			close(done)
		}()
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("upstream request did not start")
		}
		cancel()
		select {
		case <-cancelled:
		case <-time.After(time.Second):
			t.Fatal("upstream request was not cancelled promptly")
		}
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("Vesta request did not stop after cancellation")
		}
	})
}

func TestUpstreamErrorsAndHiddenFieldMetadata(t *testing.T) {
	t.Run("upstream error is normalized", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "bad LogsQL", http.StatusUnprocessableEntity)
		}))
		defer upstream.Close()
		handler := testHandler(t, upstream.URL, config.LimitsConfig{})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h"))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusBadGateway || !strings.Contains(recorder.Body.String(), "bad LogsQL") {
			t.Fatalf("upstream error not propagated safely: status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("hidden metadata is inaccessible", func(t *testing.T) {
		calls := 0
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			calls++
			_, _ = io.WriteString(w, `{"values":[{"value":"host","hits":4},{"value":"password_hash","hits":2}]}`)
		}))
		defer upstream.Close()
		handler := testHandler(t, upstream.URL, config.LimitsConfig{})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/fields", queryBody("_time:1h"))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusOK || strings.Contains(recorder.Body.String(), "password_hash") || !strings.Contains(recorder.Body.String(), "host") {
			t.Fatalf("field policy was not applied: status=%d body=%s", recorder.Code, recorder.Body.String())
		}

		valueBody, _ := json.Marshal(map[string]any{
			"sourceId": "prod", "tenant": map[string]string{"accountId": "12", "projectId": "34"},
			"query": "_time:1h", "field": "password_hash",
		})
		req = httptest.NewRequest(http.MethodPost, "/api/v1/field-values", bytes.NewReader(valueBody))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder = httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusForbidden || calls != 1 {
			t.Fatalf("hidden field values reached upstream: status=%d calls=%d", recorder.Code, calls)
		}
	})
}

func TestQueryRequiresActualTimeFilter(t *testing.T) {
	called := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer upstream.Close()
	handler := testHandler(t, upstream.URL, config.LimitsConfig{})
	for _, query := range []string{"error | fields _time", "error # _time:1h", `"_time:1h"`} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody(query))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusUnprocessableEntity {
			t.Fatalf("query %q status = %d", query, recorder.Code)
		}
	}
	if called {
		t.Fatal("invalid query reached VictoriaLogs")
	}
}

func TestQueryEmitsVisibleTruncation(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "{\"_time\":\"1\",\"_msg\":\"one\"}\n{\"_time\":\"2\",\"_msg\":\"two\"}\n")
	}))
	defer upstream.Close()
	handler := testHandler(t, upstream.URL, config.LimitsConfig{MaxRows: 1})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h"))
	req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if !strings.Contains(recorder.Body.String(), `"status":"truncated"`) || !strings.Contains(recorder.Body.String(), "viewer safety limit") {
		t.Fatalf("truncation was not visible: %s", recorder.Body.String())
	}
}

func TestSessionReturnsOnlyAuthorizedContexts(t *testing.T) {
	upstream := httptest.NewServer(http.NotFoundHandler())
	defer upstream.Close()
	handler := testHandler(t, upstream.URL, config.LimitsConfig{})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/session", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), upstream.URL) {
		t.Fatal("VictoriaLogs URL leaked to the browser")
	}
	if !strings.Contains(recorder.Body.String(), `"id":"prod"`) || !strings.Contains(recorder.Body.String(), `"accountId":"12"`) {
		t.Fatalf("missing authorized source: %s", recorder.Body.String())
	}
}
