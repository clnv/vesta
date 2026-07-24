package storage

import (
	"context"
	"errors"
	"slices"
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
		Query: "_time:1h error", SourceID: "prod", ResultMode: "table", CreatedBy: member.ID,
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

	archive, err := store.CreateFolder(ctx, admin.Teams[0].ID, "Archive", member.ID)
	if err != nil {
		t.Fatal(err)
	}
	updated, err := store.UpdateTeamQuery(ctx, UpdateTeamQueryInput{
		ID: item.ID, FolderID: archive.ID, Title: "Priority errors", UserID: member.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Title != "Priority errors" || updated.FolderID != archive.ID || updated.UpdatedAt.IsZero() {
		t.Fatalf("unexpected updated team query: %#v", updated)
	}
	if _, err := store.UpdateTeamQuery(ctx, UpdateTeamQueryInput{
		ID: item.ID, FolderID: archive.ID, Title: " ", UserID: member.ID,
	}); err == nil {
		t.Fatal("empty team star name was accepted")
	}

	other, err := store.CreateUser(ctx, CreateUserInput{
		Email: "other@example.test", Name: "Other", Password: "other-secure-password",
		Roles: []string{"reader"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AddTeamMember(ctx, admin.Teams[0].ID, other.ID); err != nil {
		t.Fatal(err)
	}
	privateItem, err := store.CreatePersonalQuery(ctx, CreatePersonalQueryInput{
		UserID: member.ID, Title: "My investigation", Query: "_time:30m warning",
		SourceID: "prod", ResultMode: "table",
	})
	if err != nil {
		t.Fatal(err)
	}
	personal, err := store.ListPersonalQueries(ctx, member.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(personal) != 1 || personal[0].ID != privateItem.ID {
		t.Fatalf("unexpected personal library: %#v", personal)
	}
	adminPersonal, err := store.ListPersonalQueries(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(adminPersonal) != 0 {
		t.Fatalf("another user's personal stars were visible: %#v", adminPersonal)
	}
	if _, err := store.UpdatePersonalQuery(ctx, UpdatePersonalQueryInput{
		ID: privateItem.ID, UserID: other.ID, Title: "Not mine",
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another user updated a personal star: %v", err)
	}
	privateItem, err = store.UpdatePersonalQuery(ctx, UpdatePersonalQueryInput{
		ID: privateItem.ID, UserID: member.ID, Title: "My renamed investigation",
	})
	if err != nil || privateItem.Title != "My renamed investigation" {
		t.Fatalf("personal star was not renamed: item=%#v err=%v", privateItem, err)
	}
	collaborativeUpdate, err := store.UpdateTeamQuery(ctx, UpdateTeamQueryInput{
		ID: item.ID, FolderID: "", Title: "Team-owned errors", UserID: other.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if collaborativeUpdate.Title != "Team-owned errors" || collaborativeUpdate.FolderID != "" {
		t.Fatalf("unexpected teammate update: %#v", collaborativeUpdate)
	}

	libraries, err = store.ListTeamLibraries(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(libraries) != 1 || len(libraries[0].Queries) != 1 ||
		libraries[0].Queries[0].Title != "Team-owned errors" {
		t.Fatalf("teammate update was not persisted: %#v", libraries)
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

func TestUserSettingsHaveDefaultsAndRemainPrivate(t *testing.T) {
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
	admin, err := store.Authenticate(ctx, "admin@example.test", "correct-horse-battery")
	if err != nil {
		t.Fatal(err)
	}
	member, err := store.CreateUser(ctx, CreateUserInput{
		Email: "member@example.test", Name: "Member", Password: "another-secure-password",
		Roles: []string{"reader"},
	})
	if err != nil {
		t.Fatal(err)
	}

	adminSettings, err := store.GetUserSettings(ctx, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(adminSettings.HiddenResultFields, DefaultUserSettings().HiddenResultFields) {
		t.Fatalf("unexpected default settings: %#v", adminSettings)
	}

	updated, err := store.UpdateUserSettings(ctx, admin.ID, UserSettings{
		HiddenResultFields: []string{" trace_* ", "request_id", "trace_*"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(updated.HiddenResultFields, []string{"trace_*", "request_id"}) {
		t.Fatalf("unexpected normalized settings: %#v", updated)
	}
	reloaded, err := store.GetUserSettings(ctx, admin.ID)
	if err != nil || !slices.Equal(reloaded.HiddenResultFields, updated.HiddenResultFields) {
		t.Fatalf("settings did not persist: settings=%#v err=%v", reloaded, err)
	}
	memberSettings, err := store.GetUserSettings(ctx, member.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(memberSettings.HiddenResultFields, DefaultUserSettings().HiddenResultFields) {
		t.Fatalf("another user's settings changed: %#v", memberSettings)
	}

	cleared, err := store.UpdateUserSettings(ctx, admin.ID, UserSettings{HiddenResultFields: []string{}})
	if err != nil || len(cleared.HiddenResultFields) != 0 {
		t.Fatalf("empty hidden field list was not accepted: settings=%#v err=%v", cleared, err)
	}
	if _, err := store.UpdateUserSettings(ctx, admin.ID, UserSettings{
		HiddenResultFields: []string{"valid", " "},
	}); err == nil {
		t.Fatal("blank hidden result field was accepted")
	}
	if _, err := store.GetUserSettings(ctx, "missing-user"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing user settings error = %v", err)
	}
}

func TestUpdateUserAndTeamManagement(t *testing.T) {
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
	admin, err := store.Authenticate(ctx, "admin@example.test", "correct-horse-battery")
	if err != nil {
		t.Fatal(err)
	}
	member, err := store.CreateUser(ctx, CreateUserInput{
		Email: "member@example.test", Name: "Member", Password: "another-secure-password",
		Roles: []string{"legacy"},
	})
	if err != nil {
		t.Fatal(err)
	}
	team, err := store.CreateTeam(ctx, "On call")
	if err != nil {
		t.Fatal(err)
	}

	updated, err := store.UpdateUser(ctx, member.ID, UpdateUserInput{
		Email: "renamed@example.test", Name: "Renamed member", Roles: []string{"reader", "writer"},
		IsAdmin: true, TeamIDs: []string{team.ID, team.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Email != "renamed@example.test" || updated.Name != "Renamed member" || !updated.IsAdmin ||
		len(updated.Roles) != 2 || len(updated.Teams) != 1 || updated.Teams[0].ID != team.ID {
		t.Fatalf("unexpected updated user: %#v", updated)
	}

	if _, err := store.UpdateUser(ctx, member.ID, UpdateUserInput{
		Email: admin.Email, Name: member.Name, Roles: member.Roles, TeamIDs: []string{team.ID},
	}); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate email error = %v", err)
	}
	if _, err := store.UpdateUser(ctx, member.ID, UpdateUserInput{
		Email: member.Email, Name: member.Name, Roles: member.Roles, TeamIDs: []string{"missing-team"},
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing team error = %v", err)
	}
	afterFailure, err := store.GetUser(ctx, member.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterFailure.Email != updated.Email || len(afterFailure.Teams) != 1 || afterFailure.Teams[0].ID != team.ID {
		t.Fatalf("failed update was not atomic: %#v", afterFailure)
	}

	renamed, err := store.UpdateTeam(ctx, team.ID, "Incident response")
	if err != nil || renamed.Name != "Incident response" {
		t.Fatalf("renamed team = %#v, err = %v", renamed, err)
	}
	if _, err := store.UpdateTeam(ctx, team.ID, admin.Teams[0].Name); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate team name error = %v", err)
	}
	if _, err := store.UpdateTeam(ctx, "missing-team", "Missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing team update error = %v", err)
	}
}

func TestUpdateUserRetainsAnActiveAdministrator(t *testing.T) {
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
	admin, err := store.Authenticate(ctx, "admin@example.test", "correct-horse-battery")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateUser(ctx, admin.ID, UpdateUserInput{
		Email: admin.Email, Name: admin.Name, Roles: admin.Roles, Disabled: true,
		TeamIDs: []string{admin.Teams[0].ID},
	}); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("last administrator suspension error = %v", err)
	}

	second, err := store.CreateUser(ctx, CreateUserInput{
		Email: "admin2@example.test", Name: "Second admin", Password: "another-secure-password",
		Roles: []string{"reader"}, IsAdmin: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateUser(ctx, admin.ID, UpdateUserInput{
		Email: admin.Email, Name: admin.Name, Roles: admin.Roles, Disabled: true,
		TeamIDs: []string{admin.Teams[0].ID},
	}); err != nil {
		t.Fatalf("suspend with another active administrator: %v", err)
	}
	if _, err := store.GetUser(ctx, second.ID); err != nil {
		t.Fatal(err)
	}
}
