package server

import (
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/vesta-explorer/vesta/internal/auth"
	"github.com/vesta-explorer/vesta/internal/storage"
)

type createFolderRequest struct {
	TeamID string `json:"teamId"`
	Name   string `json:"name"`
}

type createTeamQueryRequest struct {
	TeamID   string      `json:"teamId"`
	FolderID string      `json:"folderId"`
	Payload  sharedQuery `json:"payload"`
}

func (s *Server) handleTeamLibrary(w http.ResponseWriter, r *http.Request) {
	user := auth.MustUser(r.Context())
	libraries, err := s.store.ListTeamLibraries(r.Context(), user.Subject)
	if err != nil {
		s.logger.Error("list team query library", "subject", user.Subject, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "team queries could not be loaded")
		return
	}
	for libraryIndex := range libraries {
		libraries[libraryIndex].Queries = slices.DeleteFunc(libraries[libraryIndex].Queries, func(item storage.TeamQuery) bool {
			return !s.teamQueryAuthorized(user, item)
		})
		for folderIndex := range libraries[libraryIndex].Folders {
			libraries[libraryIndex].Folders[folderIndex].Queries = slices.DeleteFunc(
				libraries[libraryIndex].Folders[folderIndex].Queries,
				func(item storage.TeamQuery) bool { return !s.teamQueryAuthorized(user, item) },
			)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"teams": libraries})
}

func (s *Server) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	var input createFolderRequest
	if !decodeAPIJSON(w, r, &input) {
		return
	}
	user := auth.MustUser(r.Context())
	folder, err := s.store.CreateFolder(r.Context(), input.TeamID, input.Name, user.Subject)
	switch {
	case err == nil:
		writeJSON(w, http.StatusCreated, folder)
	case errors.Is(err, storage.ErrNotFound):
		writeJSONError(w, http.StatusForbidden, "you are not a member of that team")
	case errors.Is(err, storage.ErrConflict):
		writeJSONError(w, http.StatusConflict, "that team already has a folder with this name")
	default:
		writeJSONError(w, http.StatusBadRequest, err.Error())
	}
}

func (s *Server) handleCreateTeamQuery(w http.ResponseWriter, r *http.Request) {
	var input createTeamQueryRequest
	if !decodeAPIJSON(w, r, &input) {
		return
	}
	if message := validateSharedQuery(input.Payload); message != "" {
		writeJSONError(w, http.StatusBadRequest, message)
		return
	}
	user := auth.MustUser(r.Context())
	source, tenant, allowed := s.authorize(user, queryRequest{
		SourceID: input.Payload.SourceID,
		Tenant:   input.Payload.Tenant,
		Query:    input.Payload.Query,
	})
	if !allowed {
		writeJSONError(w, http.StatusForbidden, "you cannot save this source or tenant")
		return
	}
	item, err := s.store.CreateTeamQuery(r.Context(), storage.CreateTeamQueryInput{
		TeamID: input.TeamID, FolderID: input.FolderID,
		Title: input.Payload.Title, Query: input.Payload.Query, SourceID: source.ID,
		TenantAccountID: tenant.AccountID, TenantProjectID: tenant.ProjectID, TenantName: tenant.Name,
		ResultMode: input.Payload.ResultMode, CreatedBy: user.Subject,
	})
	switch {
	case err == nil:
		writeJSON(w, http.StatusCreated, item)
	case errors.Is(err, storage.ErrNotFound):
		writeJSONError(w, http.StatusForbidden, "team or folder is not available")
	default:
		writeJSONError(w, http.StatusBadRequest, err.Error())
	}
}

func (s *Server) handleDeleteTeamQuery(w http.ResponseWriter, r *http.Request) {
	user := auth.MustUser(r.Context())
	err := s.store.DeleteTeamQuery(r.Context(), r.PathValue("id"), user.Subject, user.IsAdmin)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, storage.ErrNotFound):
		writeJSONError(w, http.StatusNotFound, "team query was not found or cannot be deleted")
	default:
		s.logger.Error("delete team query", "subject", user.Subject, "error", err)
		writeJSONError(w, http.StatusInternalServerError, "team query could not be deleted")
	}
}

func (s *Server) teamQueryAuthorized(user auth.User, item storage.TeamQuery) bool {
	_, _, allowed := s.authorize(user, queryRequest{
		SourceID: item.SourceID,
		Tenant: tenantRequest{
			AccountID: item.TenantAccountID,
			ProjectID: item.TenantProjectID,
			Name:      item.TenantName,
		},
		Query: strings.TrimSpace(item.Query),
	})
	return allowed
}
