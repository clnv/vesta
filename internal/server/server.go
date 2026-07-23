package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"github.com/vesta-explorer/vesta/internal/auth"
	"github.com/vesta-explorer/vesta/internal/config"
	"github.com/vesta-explorer/vesta/internal/victoria"
)

type Server struct {
	cfg     *config.Config
	auth    *auth.Authenticator
	vlogs   *victoria.Client
	logger  *slog.Logger
	gate    *concurrencyGate
	metrics *metrics
}

type tenantRequest struct {
	AccountID string `json:"accountId"`
	ProjectID string `json:"projectId"`
	Name      string `json:"name,omitempty"`
}

type queryRequest struct {
	SourceID string        `json:"sourceId"`
	Tenant   tenantRequest `json:"tenant"`
	Query    string        `json:"query"`
	Field    string        `json:"field,omitempty"`
}

type sourceView struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Tenants []config.Tenant `json:"tenants"`
}

func New(cfg *config.Config, authenticator *auth.Authenticator, client *victoria.Client, logger *slog.Logger) http.Handler {
	s := &Server{
		cfg: cfg, auth: authenticator, vlogs: client, logger: logger,
		gate:    newConcurrencyGate(cfg.Limits.MaxQueriesPerUser, cfg.Limits.MaxTailsPerUser),
		metrics: &metrics{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("GET /metrics", s.metrics.handler)
	mux.HandleFunc("GET /auth/login", authenticator.Login)
	mux.HandleFunc("GET /auth/callback", authenticator.Callback)
	mux.HandleFunc("GET /auth/logout", authenticator.Logout)
	mux.Handle("GET /api/v1/session", s.withUser(http.HandlerFunc(s.handleSession)))
	mux.Handle("POST /api/v1/query", s.withUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.handleStream(w, r, false) })))
	mux.Handle("POST /api/v1/tail", s.withUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.handleStream(w, r, true) })))
	mux.Handle("POST /api/v1/fields", s.withUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.handleMetadata(w, r, false) })))
	mux.Handle("POST /api/v1/field-values", s.withUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.handleMetadata(w, r, true) })))
	return securityHeaders(mux)
}

func (s *Server) withUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := s.auth.Current(r)
		if !ok {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		if err := s.auth.CheckCSRF(r, user); err != nil {
			writeJSONError(w, http.StatusForbidden, err.Error())
			return
		}
		next.ServeHTTP(w, r.WithContext(auth.WithUser(r.Context(), user)))
	})
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	user := auth.MustUser(r.Context())
	sources := make([]sourceView, 0, len(s.cfg.Sources))
	for _, source := range s.cfg.Sources {
		if !hasAnyRole(user.Roles, source.Roles) {
			continue
		}
		view := sourceView{ID: source.ID, Name: source.Name}
		for _, tenant := range source.Tenants {
			if len(tenant.Roles) == 0 || hasAnyRole(user.Roles, tenant.Roles) {
				view.Tenants = append(view.Tenants, tenant)
			}
		}
		if len(view.Tenants) > 0 {
			sources = append(sources, view)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":      map[string]any{"subject": user.Subject, "email": user.Email, "name": user.Name},
		"sources":   sources,
		"csrfToken": user.CSRF,
		"limits": map[string]any{
			"queryTimeoutMs": s.cfg.Limits.QueryTimeout.Milliseconds(),
			"maxRows":        s.cfg.Limits.MaxRows,
			"maxBytes":       s.cfg.Limits.MaxBytes,
			"maxQueries":     s.cfg.Limits.MaxQueriesPerUser,
			"maxTails":       s.cfg.Limits.MaxTailsPerUser,
		},
	})
}

func (s *Server) authorize(user auth.User, input queryRequest) (config.SourceConfig, config.Tenant, bool) {
	for _, source := range s.cfg.Sources {
		if source.ID != input.SourceID || !hasAnyRole(user.Roles, source.Roles) {
			continue
		}
		for _, tenant := range source.Tenants {
			if tenant.AccountID == input.Tenant.AccountID && tenant.ProjectID == input.Tenant.ProjectID && (len(tenant.Roles) == 0 || hasAnyRole(user.Roles, tenant.Roles)) {
				return source, tenant, true
			}
		}
	}
	return config.SourceConfig{}, config.Tenant{}, false
}

func hasAnyRole(userRoles, allowed []string) bool {
	for _, role := range userRoles {
		if slices.Contains(allowed, role) {
			return true
		}
	}
	return false
}

func decodeQueryRequest(w http.ResponseWriter, r *http.Request) (queryRequest, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input queryRequest
	if err := decoder.Decode(&input); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return queryRequest{}, false
	}
	input.Query = strings.TrimSpace(input.Query)
	if input.SourceID == "" || input.Tenant.AccountID == "" || input.Tenant.ProjectID == "" || input.Query == "" {
		writeJSONError(w, http.StatusBadRequest, "sourceId, tenant, and query are required")
		return queryRequest{}, false
	}
	return input, true
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
