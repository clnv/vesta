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
