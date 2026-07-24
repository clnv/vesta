package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/vesta-explorer/vesta/internal/auth"
	"github.com/vesta-explorer/vesta/internal/storage"
)

type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

type createUserRequest struct {
	Email    string   `json:"email"`
	Name     string   `json:"name"`
	Password string   `json:"password"`
	Roles    []string `json:"roles"`
	IsAdmin  bool     `json:"isAdmin"`
}

type createTeamRequest struct {
	Name string `json:"name"`
}

type updateUserRequest struct {
	Email    string   `json:"email"`
	Name     string   `json:"name"`
	Roles    []string `json:"roles"`
	IsAdmin  bool     `json:"isAdmin"`
	Disabled bool     `json:"disabled"`
	TeamIDs  []string `json:"teamIds"`
}

type membershipRequest struct {
	UserID string `json:"userId"`
	TeamID string `json:"teamId"`
}

type permissionCatalog struct {
	Roles   []string           `json:"roles"`
	Sources []permissionSource `json:"sources"`
}

type permissionSource struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Roles []string `json:"roles"`
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var input changePasswordRequest
	if !decodeAPIJSON(w, r, &input) {
		return
	}
	user := auth.MustUser(r.Context())
	if err := s.store.UpdatePassword(r.Context(), user.Subject, input.CurrentPassword, input.NewPassword); err != nil {
		switch {
		case errors.Is(err, storage.ErrInvalidCredentials):
			writeJSONError(w, http.StatusForbidden, "current password is incorrect")
		default:
			writeJSONError(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDirectory(w http.ResponseWriter, r *http.Request) {
	directory, err := s.store.ListDirectory(r.Context())
	if err != nil {
		s.logger.Error("list local directory", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "directory could not be loaded")
		return
	}
	writeJSON(w, http.StatusOK, directory)
}

func (s *Server) handlePermissions(w http.ResponseWriter, _ *http.Request) {
	roles := make([]string, 0)
	roleSet := s.configuredRoleSet()
	for role := range roleSet {
		roles = append(roles, role)
	}
	sort.Strings(roles)

	sources := make([]permissionSource, 0, len(s.cfg.Sources))
	for _, source := range s.cfg.Sources {
		sources = append(sources, permissionSource{
			ID: source.ID, Name: source.Name, Roles: append([]string{}, source.Roles...),
		})
	}
	writeJSON(w, http.StatusOK, permissionCatalog{Roles: roles, Sources: sources})
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var input createUserRequest
	if !decodeAPIJSON(w, r, &input) {
		return
	}
	if role := s.firstUnassignableRole(input.Roles, nil); role != "" {
		writeJSONError(w, http.StatusBadRequest, "role "+role+" is not configured")
		return
	}
	user, err := s.store.CreateUser(r.Context(), storage.CreateUserInput{
		Email: input.Email, Name: input.Name, Password: input.Password,
		Roles: input.Roles, IsAdmin: input.IsAdmin,
	})
	if err != nil {
		if errors.Is(err, storage.ErrConflict) {
			writeJSONError(w, http.StatusConflict, "a user with that email already exists")
			return
		}
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, user)
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	var input updateUserRequest
	if !decodeAPIJSON(w, r, &input) {
		return
	}
	id := r.PathValue("id")
	current, err := s.store.GetUser(r.Context(), id)
	if errors.Is(err, storage.ErrNotFound) {
		writeJSONError(w, http.StatusNotFound, "user was not found")
		return
	}
	if err != nil {
		s.logger.Error("load local user for update", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "user could not be updated")
		return
	}
	actor := auth.MustUser(r.Context())
	if actor.Subject == id && (!input.IsAdmin || input.Disabled) {
		writeJSONError(w, http.StatusConflict, "you cannot demote or suspend your own administrator account")
		return
	}
	if role := s.firstUnassignableRole(input.Roles, current.Roles); role != "" {
		writeJSONError(w, http.StatusBadRequest, "role "+role+" is not configured")
		return
	}
	user, err := s.store.UpdateUser(r.Context(), id, storage.UpdateUserInput{
		Email: input.Email, Name: input.Name, Roles: input.Roles,
		IsAdmin: input.IsAdmin, Disabled: input.Disabled, TeamIDs: input.TeamIDs,
	})
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, user)
	case errors.Is(err, storage.ErrNotFound):
		writeJSONError(w, http.StatusNotFound, "user or team was not found")
	case errors.Is(err, storage.ErrConflict):
		writeJSONError(w, http.StatusConflict, "a user with that email already exists")
	case errors.Is(err, storage.ErrLastAdmin):
		writeJSONError(w, http.StatusConflict, err.Error())
	default:
		writeJSONError(w, http.StatusBadRequest, err.Error())
	}
}

func (s *Server) handleCreateTeam(w http.ResponseWriter, r *http.Request) {
	var input createTeamRequest
	if !decodeAPIJSON(w, r, &input) {
		return
	}
	team, err := s.store.CreateTeam(r.Context(), input.Name)
	if err != nil {
		if errors.Is(err, storage.ErrConflict) {
			writeJSONError(w, http.StatusConflict, "a team with that name already exists")
			return
		}
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, team)
}

func (s *Server) handleUpdateTeam(w http.ResponseWriter, r *http.Request) {
	var input createTeamRequest
	if !decodeAPIJSON(w, r, &input) {
		return
	}
	team, err := s.store.UpdateTeam(r.Context(), r.PathValue("id"), input.Name)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, team)
	case errors.Is(err, storage.ErrNotFound):
		writeJSONError(w, http.StatusNotFound, "team was not found")
	case errors.Is(err, storage.ErrConflict):
		writeJSONError(w, http.StatusConflict, "a team with that name already exists")
	default:
		writeJSONError(w, http.StatusBadRequest, err.Error())
	}
}

func (s *Server) handleAddMembership(w http.ResponseWriter, r *http.Request) {
	var input membershipRequest
	if !decodeAPIJSON(w, r, &input) {
		return
	}
	err := s.store.AddTeamMember(r.Context(), input.TeamID, input.UserID)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, storage.ErrConflict):
		writeJSONError(w, http.StatusConflict, "the user is already a member of that team")
	case errors.Is(err, storage.ErrNotFound):
		writeJSONError(w, http.StatusNotFound, "user or team was not found")
	default:
		s.logger.Error("add local team membership", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "membership could not be created")
	}
}

func (s *Server) handleDeleteMembership(w http.ResponseWriter, r *http.Request) {
	var input membershipRequest
	if !decodeAPIJSON(w, r, &input) {
		return
	}
	err := s.store.RemoveTeamMember(r.Context(), input.TeamID, input.UserID)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, storage.ErrNotFound):
		writeJSONError(w, http.StatusNotFound, "membership was not found")
	default:
		s.logger.Error("remove local team membership", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "membership could not be removed")
	}
}

func (s *Server) configuredRoleSet() map[string]struct{} {
	roles := make(map[string]struct{})
	for _, source := range s.cfg.Sources {
		for _, role := range source.Roles {
			roles[strings.TrimSpace(role)] = struct{}{}
		}
	}
	delete(roles, "")
	return roles
}

func (s *Server) firstUnassignableRole(requested, existing []string) string {
	allowed := s.configuredRoleSet()
	for _, role := range existing {
		allowed[strings.TrimSpace(role)] = struct{}{}
	}
	for _, role := range requested {
		role = strings.TrimSpace(role)
		if _, ok := allowed[role]; !ok {
			return role
		}
	}
	return ""
}

func decodeAPIJSON(w http.ResponseWriter, r *http.Request, destination any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}
