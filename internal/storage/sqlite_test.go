package storage

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

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
