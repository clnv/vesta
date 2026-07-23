package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

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

type membershipRequest struct {
	UserID string `json:"userId"`
	TeamID string `json:"teamId"`
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

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var input createUserRequest
	if !decodeAPIJSON(w, r, &input) {
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
