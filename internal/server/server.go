package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"github.com/vesta-explorer/vesta/internal/auth"
	"github.com/vesta-explorer/vesta/internal/config"
	"github.com/vesta-explorer/vesta/internal/storage"
	"github.com/vesta-explorer/vesta/internal/victoria"
)

type Server struct {
	cfg     *config.Config
	auth    *auth.Authenticator
	vlogs   *victoria.Client
	store   *storage.Store
	logger  *slog.Logger
	gate    *concurrencyGate
	metrics *metrics
}

type queryRequest struct {
	SourceID string `json:"sourceId"`
	Query    string `json:"query"`
	Field    string `json:"field,omitempty"`
}

type sourceView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func New(cfg *config.Config, authenticator *auth.Authenticator, store *storage.Store, client *victoria.Client, logger *slog.Logger) http.Handler {
	s := &Server{
		cfg: cfg, auth: authenticator, store: store, vlogs: client, logger: logger,
		gate:    newConcurrencyGate(cfg.Limits.MaxQueriesPerUser),
		metrics: &metrics{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("GET /metrics", s.metrics.handler)
	mux.HandleFunc("POST /auth/login", authenticator.Login)
	mux.HandleFunc("GET /auth/logout", authenticator.Logout)
	mux.Handle("GET /api/v1/session", s.withUser(http.HandlerFunc(s.handleSession)))
	mux.Handle("POST /api/v1/account/password", s.withUser(http.HandlerFunc(s.handleChangePassword)))
	mux.Handle("PUT /api/v1/account/settings", s.withUser(http.HandlerFunc(s.handleUpdateSettings)))
	mux.Handle("POST /api/v1/query", s.withUser(http.HandlerFunc(s.handleStream)))
	mux.Handle("POST /api/v1/fields", s.withUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.handleMetadata(w, r, false) })))
	mux.Handle("POST /api/v1/field-values", s.withUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.handleMetadata(w, r, true) })))
	mux.Handle("POST /api/v1/shares", s.withUser(http.HandlerFunc(s.handleCreateShare)))
	mux.Handle("POST /api/v1/shares/open", s.withUser(http.HandlerFunc(s.handleOpenShare)))
	mux.Handle("GET /api/v1/star-library", s.withUser(http.HandlerFunc(s.handleStarLibrary)))
	mux.Handle("GET /api/v1/team-library", s.withUser(http.HandlerFunc(s.handleStarLibrary)))
	mux.Handle("POST /api/v1/personal-queries", s.withUser(http.HandlerFunc(s.handleCreatePersonalQuery)))
	mux.Handle("POST /api/v1/personal-queries/{id}", s.withUser(http.HandlerFunc(s.handleUpdatePersonalQuery)))
	mux.Handle("DELETE /api/v1/personal-queries/{id}", s.withUser(http.HandlerFunc(s.handleDeletePersonalQuery)))
	mux.Handle("POST /api/v1/team-folders", s.withUser(http.HandlerFunc(s.handleCreateFolder)))
	mux.Handle("POST /api/v1/team-queries", s.withUser(http.HandlerFunc(s.handleCreateTeamQuery)))
	mux.Handle("POST /api/v1/team-queries/{id}", s.withUser(http.HandlerFunc(s.handleUpdateTeamQuery)))
	mux.Handle("DELETE /api/v1/team-queries/{id}", s.withUser(http.HandlerFunc(s.handleDeleteTeamQuery)))
	mux.Handle("GET /api/v1/admin/directory", s.withUser(s.adminOnly(http.HandlerFunc(s.handleDirectory))))
	mux.Handle("GET /api/v1/admin/permissions", s.withUser(s.adminOnly(http.HandlerFunc(s.handlePermissions))))
	mux.Handle("POST /api/v1/admin/users", s.withUser(s.adminOnly(http.HandlerFunc(s.handleCreateUser))))
	mux.Handle("PUT /api/v1/admin/users/{id}", s.withUser(s.adminOnly(http.HandlerFunc(s.handleUpdateUser))))
	mux.Handle("POST /api/v1/admin/teams", s.withUser(s.adminOnly(http.HandlerFunc(s.handleCreateTeam))))
	mux.Handle("PUT /api/v1/admin/teams/{id}", s.withUser(s.adminOnly(http.HandlerFunc(s.handleUpdateTeam))))
	mux.Handle("POST /api/v1/admin/memberships", s.withUser(s.adminOnly(http.HandlerFunc(s.handleAddMembership))))
	mux.Handle("DELETE /api/v1/admin/memberships", s.withUser(s.adminOnly(http.HandlerFunc(s.handleDeleteMembership))))
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

func (s *Server) adminOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !auth.MustUser(r.Context()).IsAdmin {
			writeJSONError(w, http.StatusForbidden, "administrator access required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	user := auth.MustUser(r.Context())
	teams := slices.Clone(user.Teams)
	if teams == nil {
		teams = []auth.Team{}
	}
	sources := make([]sourceView, 0, len(s.cfg.Sources))
	for _, source := range s.cfg.Sources {
		if hasAnyRole(user.Roles, source.Roles) {
			sources = append(sources, sourceView{ID: source.ID, Name: source.Name})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{
			"subject": user.Subject, "email": user.Email, "name": user.Name,
			"teams": teams, "isAdmin": user.IsAdmin,
			"settings": map[string]any{"hiddenResultFields": slices.Clone(user.HiddenResultFields)},
		},
		"sources":   sources,
		"csrfToken": user.CSRF,
		"limits": map[string]any{
			"queryTimeoutMs": s.cfg.Limits.QueryTimeout.Milliseconds(),
			"maxRows":        s.cfg.Limits.MaxRows,
			"maxBytes":       s.cfg.Limits.MaxBytes,
			"maxQueries":     s.cfg.Limits.MaxQueriesPerUser,
		},
	})
}

func (s *Server) authorize(user auth.User, input queryRequest) (config.SourceConfig, bool) {
	for _, source := range s.cfg.Sources {
		if source.ID == input.SourceID && hasAnyRole(user.Roles, source.Roles) {
			return source, true
		}
	}
	return config.SourceConfig{}, false
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
	if input.SourceID == "" || input.Query == "" {
		writeJSONError(w, http.StatusBadRequest, "sourceId and query are required")
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
