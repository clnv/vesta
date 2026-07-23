package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

type Folder struct {
	ID        string      `json:"id"`
	TeamID    string      `json:"teamId"`
	Name      string      `json:"name"`
	Queries   []TeamQuery `json:"queries"`
	CreatedAt time.Time   `json:"createdAt"`
}

type TeamQuery struct {
	ID              string    `json:"id"`
	TeamID          string    `json:"teamId"`
	FolderID        string    `json:"folderId,omitempty"`
	Title           string    `json:"title"`
	Query           string    `json:"query"`
	SourceID        string    `json:"sourceId"`
	TenantAccountID string    `json:"tenantAccountId"`
	TenantProjectID string    `json:"tenantProjectId"`
	TenantName      string    `json:"tenantName"`
	ResultMode      string    `json:"resultMode"`
	CreatedBy       string    `json:"createdBy"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type TeamLibrary struct {
	Team    Team        `json:"team"`
	Folders []Folder    `json:"folders"`
	Queries []TeamQuery `json:"queries"`
}

type CreateTeamQueryInput struct {
	TeamID          string
	FolderID        string
	Title           string
	Query           string
	SourceID        string
	TenantAccountID string
	TenantProjectID string
	TenantName      string
	ResultMode      string
	CreatedBy       string
}

func (s *Store) CreateFolder(ctx context.Context, teamID, name, createdBy string) (Folder, error) {
	if _, err := s.TeamForMember(ctx, teamID, createdBy); err != nil {
		return Folder{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 {
		return Folder{}, errors.New("folder name is required and must not exceed 120 characters")
	}
	id, err := randomID()
	if err != nil {
		return Folder{}, err
	}
	now := time.Now()
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO folders (id, team_id, name, created_by, created_at)
		VALUES (?, ?, ?, ?, ?)`,
		id, teamID, name, createdBy, now.Unix(),
	)
	if err != nil {
		if isUniqueError(err) {
			return Folder{}, ErrConflict
		}
		return Folder{}, fmt.Errorf("create folder: %w", err)
	}
	return Folder{ID: id, TeamID: teamID, Name: name, Queries: []TeamQuery{}, CreatedAt: now}, nil
}

func (s *Store) CreateTeamQuery(ctx context.Context, input CreateTeamQueryInput) (TeamQuery, error) {
	if _, err := s.TeamForMember(ctx, input.TeamID, input.CreatedBy); err != nil {
		return TeamQuery{}, err
	}
	input.Title = strings.TrimSpace(input.Title)
	input.Query = strings.TrimSpace(input.Query)
	if input.Title == "" || len(input.Title) > 256 || input.Query == "" || len(input.Query) > 32<<10 {
		return TeamQuery{}, errors.New("query title or text is invalid")
	}
	if input.SourceID == "" || input.TenantAccountID == "" || input.TenantProjectID == "" {
		return TeamQuery{}, errors.New("query source and tenant are required")
	}
	if input.ResultMode != "table" && input.ResultMode != "json" {
		return TeamQuery{}, errors.New("query result mode is invalid")
	}
	var folder any
	if input.FolderID != "" {
		var exists int
		err := s.db.QueryRowContext(ctx, "SELECT 1 FROM folders WHERE id = ? AND team_id = ?", input.FolderID, input.TeamID).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			return TeamQuery{}, ErrNotFound
		}
		if err != nil {
			return TeamQuery{}, fmt.Errorf("load query folder: %w", err)
		}
		folder = input.FolderID
	}
	id, err := randomID()
	if err != nil {
		return TeamQuery{}, err
	}
	now := time.Now()
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO team_queries (
			id, team_id, folder_id, title, query, source_id,
			tenant_account_id, tenant_project_id, tenant_name, result_mode,
			created_by, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, input.TeamID, folder, input.Title, input.Query, input.SourceID,
		input.TenantAccountID, input.TenantProjectID, input.TenantName, input.ResultMode,
		input.CreatedBy, now.Unix(), now.Unix(),
	)
	if err != nil {
		return TeamQuery{}, fmt.Errorf("create team query: %w", err)
	}
	return TeamQuery{
		ID: id, TeamID: input.TeamID, FolderID: input.FolderID, Title: input.Title, Query: input.Query,
		SourceID: input.SourceID, TenantAccountID: input.TenantAccountID, TenantProjectID: input.TenantProjectID,
		TenantName: input.TenantName, ResultMode: input.ResultMode, CreatedBy: input.CreatedBy,
		CreatedAt: now, UpdatedAt: now,
	}, nil
}

func (s *Store) DeleteTeamQuery(ctx context.Context, id, userID string, isAdmin bool) error {
	query := `
		DELETE FROM team_queries
		WHERE id = ?
		  AND EXISTS (
			SELECT 1 FROM team_members
			WHERE team_members.team_id = team_queries.team_id AND team_members.user_id = ?
		  )`
	args := []any{id, userID}
	if !isAdmin {
		query += " AND created_by = ?"
		args = append(args, userID)
	}
	result, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("delete team query: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("check deleted team query: %w", err)
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListTeamLibraries(ctx context.Context, userID string) ([]TeamLibrary, error) {
	teams, err := s.TeamsForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	libraries := make([]TeamLibrary, 0, len(teams))
	byTeam := make(map[string]int, len(teams))
	for _, team := range teams {
		byTeam[team.ID] = len(libraries)
		libraries = append(libraries, TeamLibrary{Team: team, Folders: []Folder{}, Queries: []TeamQuery{}})
	}
	if len(libraries) == 0 {
		return libraries, nil
	}

	folderRows, err := s.db.QueryContext(ctx, `
		SELECT folders.id, folders.team_id, folders.name, folders.created_at
		FROM folders JOIN team_members ON team_members.team_id = folders.team_id
		WHERE team_members.user_id = ?
		ORDER BY folders.name COLLATE NOCASE`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("list team folders: %w", err)
	}
	folderLocations := map[string][2]int{}
	for folderRows.Next() {
		var folder Folder
		var createdAt int64
		if err := folderRows.Scan(&folder.ID, &folder.TeamID, &folder.Name, &createdAt); err != nil {
			_ = folderRows.Close()
			return nil, fmt.Errorf("scan team folder: %w", err)
		}
		folder.CreatedAt = time.Unix(createdAt, 0)
		folder.Queries = []TeamQuery{}
		teamIndex, ok := byTeam[folder.TeamID]
		if !ok {
			continue
		}
		folderIndex := len(libraries[teamIndex].Folders)
		libraries[teamIndex].Folders = append(libraries[teamIndex].Folders, folder)
		folderLocations[folder.ID] = [2]int{teamIndex, folderIndex}
	}
	if err := folderRows.Close(); err != nil {
		return nil, fmt.Errorf("close team folders: %w", err)
	}

	queryRows, err := s.db.QueryContext(ctx, `
		SELECT
			team_queries.id, team_queries.team_id, coalesce(team_queries.folder_id, ''),
			team_queries.title, team_queries.query, team_queries.source_id,
			team_queries.tenant_account_id, team_queries.tenant_project_id, team_queries.tenant_name,
			team_queries.result_mode, team_queries.created_by, team_queries.created_at, team_queries.updated_at
		FROM team_queries
		JOIN team_members ON team_members.team_id = team_queries.team_id
		WHERE team_members.user_id = ?
		ORDER BY team_queries.updated_at DESC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("list team queries: %w", err)
	}
	defer queryRows.Close()
	for queryRows.Next() {
		var item TeamQuery
		var createdAt int64
		var updatedAt int64
		if err := queryRows.Scan(
			&item.ID, &item.TeamID, &item.FolderID, &item.Title, &item.Query, &item.SourceID,
			&item.TenantAccountID, &item.TenantProjectID, &item.TenantName,
			&item.ResultMode, &item.CreatedBy, &createdAt, &updatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan team query: %w", err)
		}
		item.CreatedAt = time.Unix(createdAt, 0)
		item.UpdatedAt = time.Unix(updatedAt, 0)
		if location, ok := folderLocations[item.FolderID]; ok {
			libraries[location[0]].Folders[location[1]].Queries = append(libraries[location[0]].Folders[location[1]].Queries, item)
		} else if teamIndex, ok := byTeam[item.TeamID]; ok {
			libraries[teamIndex].Queries = append(libraries[teamIndex].Queries, item)
		}
	}
	if err := queryRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate team queries: %w", err)
	}
	return libraries, nil
}
