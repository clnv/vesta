package storage

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestLegacySharesSchemaMigratesForSystemLinks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = legacy.Exec(`
		CREATE TABLE shares (
			id TEXT PRIMARY KEY,
			payload BLOB NOT NULL,
			audience_type TEXT NOT NULL CHECK (audience_type IN ('user', 'team')),
			audience_value TEXT NOT NULL,
			created_by TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		) STRICT;
		CREATE INDEX shares_expires_at_idx ON shares (expires_at);
		INSERT INTO shares VALUES ('legacy-share', CAST('{}' AS BLOB), 'user', 'user-1', 'user-1', 1800000000, 2000000000);
	`)
	if err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.GetShare(context.Background(), "legacy-share", time.Unix(1_900_000_000, 0)); err != nil {
		t.Fatalf("legacy share was not preserved: %v", err)
	}
	if _, err := store.CreateShare(context.Background(), Share{
		Payload: []byte(`{}`), AudienceType: "system", AudienceValue: "*", CreatedBy: "user-1",
		CreatedAt: time.Unix(1_900_000_000, 0), ExpiresAt: time.Unix(2_000_000_000, 0),
	}); err != nil {
		t.Fatalf("system share was not accepted after migration: %v", err)
	}
}

func TestLegacyQueryLibrarySchemaIsMigrated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-library.db")
	ctx := context.Background()
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureBootstrapAdmin(ctx, BootstrapUser{
		Email: "admin@example.test", Name: "Admin", Password: "correct-horse-battery",
		Team: "Platform", Roles: []string{"reader"},
	}); err != nil {
		t.Fatal(err)
	}
	admin, err := store.Authenticate(ctx, "admin@example.test", "correct-horse-battery")
	if err != nil {
		t.Fatal(err)
	}
	folder, err := store.CreateFolder(ctx, admin.Teams[0].ID, "Incidents", admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	teamItem, err := store.CreateTeamQuery(ctx, CreateTeamQueryInput{
		TeamID: admin.Teams[0].ID, FolderID: folder.ID, Title: "Team investigation",
		Query: "_time:1h error", SourceID: "prod", ResultMode: "table", CreatedBy: admin.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	personalItem, err := store.CreatePersonalQuery(ctx, CreatePersonalQueryInput{
		UserID: admin.ID, Title: "Private investigation", Query: "_time:30m warning",
		SourceID: "prod", ResultMode: "json",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = legacy.Exec(`
		DROP INDEX personal_queries_user_idx;
		ALTER TABLE personal_queries RENAME TO personal_queries_current;
		CREATE TABLE personal_queries (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			title TEXT NOT NULL,
			query TEXT NOT NULL,
			source_id TEXT NOT NULL,
			tenant_account_id TEXT NOT NULL,
			tenant_project_id TEXT NOT NULL,
			tenant_name TEXT NOT NULL,
			result_mode TEXT NOT NULL CHECK (result_mode IN ('table', 'json', 'chart')),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		) STRICT;
		INSERT INTO personal_queries
		SELECT id, user_id, title, query, source_id, '0', '0', 'legacy', result_mode, created_at, updated_at
		FROM personal_queries_current;
		DROP TABLE personal_queries_current;
		CREATE INDEX personal_queries_user_idx ON personal_queries (user_id, updated_at DESC);

		DROP INDEX team_queries_team_folder_idx;
		ALTER TABLE team_queries RENAME TO team_queries_current;
		CREATE TABLE team_queries (
			id TEXT PRIMARY KEY,
			team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
			folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
			title TEXT NOT NULL,
			query TEXT NOT NULL,
			source_id TEXT NOT NULL,
			tenant_account_id TEXT NOT NULL,
			tenant_project_id TEXT NOT NULL,
			tenant_name TEXT NOT NULL,
			result_mode TEXT NOT NULL CHECK (result_mode IN ('table', 'json')),
			created_by TEXT NOT NULL REFERENCES users(id),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		) STRICT;
		INSERT INTO team_queries
		SELECT
			id, team_id, folder_id, title, query, source_id, '0', '0', 'legacy',
			result_mode, created_by, created_at, updated_at
		FROM team_queries_current;
		DROP TABLE team_queries_current;
		CREATE INDEX team_queries_team_folder_idx ON team_queries (team_id, folder_id, updated_at DESC);
	`)
	if err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	personal, err := store.ListPersonalQueries(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(personal) != 1 || personal[0].ID != personalItem.ID {
		t.Fatalf("legacy personal query was not preserved: %#v", personal)
	}
	libraries, err := store.ListTeamLibraries(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(libraries) != 1 || len(libraries[0].Folders) != 1 ||
		len(libraries[0].Folders[0].Queries) != 1 ||
		libraries[0].Folders[0].Queries[0].ID != teamItem.ID {
		t.Fatalf("legacy team query was not preserved: %#v", libraries)
	}
	if _, err := store.CreatePersonalQuery(ctx, CreatePersonalQueryInput{
		UserID: admin.ID, Title: "New private star", Query: "_time:15m",
		SourceID: "prod", ResultMode: "chart",
	}); err != nil {
		t.Fatalf("new personal query was rejected after migration: %v", err)
	}
	if _, err := store.CreateTeamQuery(ctx, CreateTeamQueryInput{
		TeamID: admin.Teams[0].ID, Title: "New team star", Query: "_time:15m",
		SourceID: "prod", ResultMode: "chart", CreatedBy: admin.ID,
	}); err != nil {
		t.Fatalf("new team query was rejected after migration: %v", err)
	}
}

func TestShareLifecyclePersistsAcrossReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vesta.db")
	now := time.Now().Truncate(time.Second)
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	id, err := store.CreateShare(context.Background(), Share{
		Payload:       []byte(`{"query":"_time:1h"}`),
		AudienceType:  "team",
		AudienceValue: "platform",
		CreatedBy:     "user-1",
		CreatedAt:     now,
		ExpiresAt:     now.Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	share, err := store.GetShare(context.Background(), id, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if share.AudienceValue != "platform" || string(share.Payload) != `{"query":"_time:1h"}` {
		t.Fatalf("unexpected share: %#v", share)
	}
}

func TestExpiredShareIsUnavailable(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Unix(1_800_000_000, 0)
	id, err := store.CreateShare(context.Background(), Share{
		Payload:       []byte(`{"query":"_time:1h"}`),
		AudienceType:  "user",
		AudienceValue: "user@example.test",
		CreatedBy:     "user-1",
		CreatedAt:     now,
		ExpiresAt:     now.Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetShare(context.Background(), id, now.Add(time.Minute)); !errors.Is(err, ErrShareNotFound) {
		t.Fatalf("expired share error = %v", err)
	}
}
