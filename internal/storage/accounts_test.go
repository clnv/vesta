package storage

import (
	"context"
	"errors"
	"testing"
)

func TestLocalAccountsTeamsAndQueryFolders(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := context.Background()

	if err := store.EnsureBootstrapAdmin(ctx, BootstrapUser{
		Email: "admin@example.test", Name: "Admin", Password: "correct-horse-battery",
		Team: "Platform", Roles: []string{"reader"},
	}); err != nil {
		t.Fatal(err)
	}
	admin, err := store.Authenticate(ctx, "ADMIN@example.test", "correct-horse-battery")
	if err != nil {
		t.Fatal(err)
	}
	if !admin.IsAdmin || len(admin.Teams) != 1 || admin.Teams[0].Name != "Platform" {
		t.Fatalf("unexpected bootstrap account: %#v", admin)
	}
	if _, err := store.Authenticate(ctx, "admin@example.test", "wrong-password"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password error = %v", err)
	}
	if err := store.UpdatePassword(ctx, admin.ID, "correct-horse-battery", "new-correct-horse-password"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Authenticate(ctx, "admin@example.test", "new-correct-horse-password"); err != nil {
		t.Fatalf("new password was not accepted: %v", err)
	}
	if err := store.EnsureBootstrapAdmin(ctx, BootstrapUser{}); err != nil {
		t.Fatalf("existing database attempted to bootstrap again: %v", err)
	}

	member, err := store.CreateUser(ctx, CreateUserInput{
		Email: "member@example.test", Name: "Member", Password: "another-secure-password",
		Roles: []string{"reader"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AddTeamMember(ctx, admin.Teams[0].ID, member.ID); err != nil {
		t.Fatal(err)
	}
	folder, err := store.CreateFolder(ctx, admin.Teams[0].ID, "Incidents", member.ID)
	if err != nil {
		t.Fatal(err)
	}
	item, err := store.CreateTeamQuery(ctx, CreateTeamQueryInput{
		TeamID: admin.Teams[0].ID, FolderID: folder.ID, Title: "Recent errors",
		Query: "_time:1h error", SourceID: "prod", TenantAccountID: "12",
		TenantProjectID: "34", TenantName: "payments", ResultMode: "table", CreatedBy: member.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	libraries, err := store.ListTeamLibraries(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(libraries) != 1 || len(libraries[0].Folders) != 1 ||
		len(libraries[0].Folders[0].Queries) != 1 || libraries[0].Folders[0].Queries[0].ID != item.ID {
		t.Fatalf("unexpected team library: %#v", libraries)
	}
}

func TestAccountValidationAndMembershipBoundaries(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := context.Background()

	if _, err := store.CreateUser(ctx, CreateUserInput{Email: "invalid", Name: "User", Password: "long-enough-password"}); err == nil {
		t.Fatal("invalid email was accepted")
	}
	if _, err := store.CreateUser(ctx, CreateUserInput{Email: "user@example.test", Name: "User", Password: "short"}); err == nil {
		t.Fatal("short password was accepted")
	}
	if err := store.AddTeamMember(ctx, "missing-team", "missing-user"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing membership error = %v", err)
	}
	if _, err := store.CreateFolder(ctx, "missing-team", "Folder", "missing-user"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("non-member folder error = %v", err)
	}
}
