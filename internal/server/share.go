package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/vesta-explorer/vesta/internal/auth"
	"github.com/vesta-explorer/vesta/internal/storage"
)

const (
	maxShareQueryBytes = 32 << 10
	maxShareTitleBytes = 256
)

type shareAudience struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

type sharedQuery struct {
	Query      string `json:"query"`
	SourceID   string `json:"sourceId"`
	Title      string `json:"title"`
	ResultMode string `json:"resultMode"`
}

type createShareRequest struct {
	Payload  sharedQuery   `json:"payload"`
	Audience shareAudience `json:"audience"`
}

type openShareRequest struct {
	Token string `json:"token"`
}

func (s *Server) handleCreateShare(w http.ResponseWriter, r *http.Request) {
	user := auth.MustUser(r.Context())
	var input createShareRequest
	if !decodeAPIJSON(w, r, &input) {
		return
	}
	if message := validateSharedQuery(input.Payload); message != "" {
		writeJSONError(w, http.StatusBadRequest, message)
		return
	}
	if _, allowed := s.authorize(user, queryRequest{
		SourceID: input.Payload.SourceID,
		Query:    input.Payload.Query,
	}); !allowed {
		writeJSONError(w, http.StatusForbidden, "you cannot share this source")
		return
	}

	input.Audience.Type = strings.ToLower(strings.TrimSpace(input.Audience.Type))
	input.Audience.Value = strings.TrimSpace(input.Audience.Value)
	if input.Audience.Type == "" {
		input.Audience.Type = "system"
	}
	if len(input.Audience.Value) > 320 {
		writeJSONError(w, http.StatusBadRequest, "share audience is too long")
		return
	}
	switch input.Audience.Type {
	case "system":
		input.Audience.Value = "*"
	case "user":
		if input.Audience.Value == "" {
			writeJSONError(w, http.StatusBadRequest, "a user email or subject is required")
			return
		}
		recipient, err := s.store.FindUser(r.Context(), input.Audience.Value)
		if errors.Is(err, storage.ErrNotFound) {
			writeJSONError(w, http.StatusBadRequest, "share recipient was not found")
			return
		}
		if err != nil {
			s.logger.Error("resolve share recipient", "subject", user.Subject, "error", err)
			writeJSONError(w, http.StatusInternalServerError, "share link could not be created")
			return
		}
		input.Audience.Value = recipient.ID
	case "team":
		if input.Audience.Value == "" {
			writeJSONError(w, http.StatusForbidden, "you can only share with one of your teams")
			return
		}
		if _, err := s.store.TeamForMember(r.Context(), input.Audience.Value, user.Subject); err != nil {
			if errors.Is(err, storage.ErrNotFound) {
				writeJSONError(w, http.StatusForbidden, "you can only share with one of your teams")
				return
			}
			s.logger.Error("resolve share team", "subject", user.Subject, "error", err)
			writeJSONError(w, http.StatusInternalServerError, "share link could not be created")
			return
		}
	default:
		writeJSONError(w, http.StatusBadRequest, "share audience must be system, user, or team")
		return
	}

	ttl := s.cfg.Storage.ShareTTL.Duration
	if ttl <= 0 {
		ttl = 7 * 24 * time.Hour
	}
	now := time.Now()
	expiresAt := now.Add(ttl)
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "share link could not be created")
		return
	}
	id, err := s.store.CreateShare(r.Context(), storage.Share{
		Payload:       payload,
		AudienceType:  input.Audience.Type,
		AudienceValue: input.Audience.Value,
		CreatedBy:     user.Subject,
		CreatedAt:     now,
		ExpiresAt:     expiresAt,
	})
	if err != nil {
		s.logger.Error("store share", "subject", user.Subject, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "share link could not be created")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": id, "expiresAt": expiresAt.Unix()})
}

func (s *Server) handleOpenShare(w http.ResponseWriter, r *http.Request) {
	user := auth.MustUser(r.Context())
	var input openShareRequest
	if !decodeAPIJSON(w, r, &input) {
		return
	}
	if len(input.Token) != 32 {
		writeJSONError(w, http.StatusBadRequest, "share token is invalid")
		return
	}

	record, err := s.store.GetShare(r.Context(), input.Token, time.Now())
	if errors.Is(err, storage.ErrShareNotFound) {
		writeJSONError(w, http.StatusNotFound, "share link is invalid or expired")
		return
	}
	if err != nil {
		s.logger.Error("load share", "subject", user.Subject, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "share link could not be opened")
		return
	}
	audience := shareAudience{Type: record.AudienceType, Value: record.AudienceValue}
	if !shareVisibleTo(audience, user) {
		writeJSONError(w, http.StatusForbidden, "this share is not available to your account")
		return
	}
	var payload sharedQuery
	if err := json.Unmarshal(record.Payload, &payload); err != nil || validateSharedQuery(payload) != "" {
		writeJSONError(w, http.StatusNotFound, "share link is invalid or expired")
		return
	}
	source, allowed := s.authorize(user, queryRequest{
		SourceID: payload.SourceID,
		Query:    payload.Query,
	})
	if !allowed {
		writeJSONError(w, http.StatusForbidden, "you are not authorized for the source in this share")
		return
	}
	payload.SourceID = source.ID
	writeJSON(w, http.StatusOK, map[string]any{
		"payload":   payload,
		"expiresAt": record.ExpiresAt.Unix(),
	})
}

func validateSharedQuery(payload sharedQuery) string {
	payload.Query = strings.TrimSpace(payload.Query)
	if payload.SourceID == "" || payload.Query == "" {
		return "share payload is incomplete"
	}
	if len(payload.Query) > maxShareQueryBytes || len(payload.Title) > maxShareTitleBytes {
		return "share payload is too large"
	}
	if payload.ResultMode != "table" && payload.ResultMode != "json" && payload.ResultMode != "chart" {
		return "share result mode is invalid"
	}
	return ""
}

func shareVisibleTo(audience shareAudience, user auth.User) bool {
	switch audience.Type {
	case "system":
		return true
	case "user":
		return audience.Value == user.Subject
	case "team":
		return slices.ContainsFunc(user.Teams, func(team auth.Team) bool { return team.ID == audience.Value })
	default:
		return false
	}
}
