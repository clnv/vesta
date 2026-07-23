package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const dummyPasswordHash = "$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi."

type User struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	Roles     []string  `json:"roles"`
	IsAdmin   bool      `json:"isAdmin"`
	Disabled  bool      `json:"disabled"`
	Teams     []Team    `json:"teams"`
	CreatedAt time.Time `json:"createdAt"`
}

type Team struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Membership struct {
	UserID string `json:"userId"`
	TeamID string `json:"teamId"`
}

type Directory struct {
	Users       []User       `json:"users"`
	Teams       []Team       `json:"teams"`
	Memberships []Membership `json:"memberships"`
}

type BootstrapUser struct {
	Email    string
	Name     string
	Password string
	Team     string
	Roles    []string
}

type CreateUserInput struct {
	Email    string
	Name     string
	Password string
	Roles    []string
	IsAdmin  bool
}

func (s *Store) EnsureBootstrapAdmin(ctx context.Context, input BootstrapUser) error {
	var count int
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM users").Scan(&count); err != nil {
		return fmt.Errorf("count users: %w", err)
	}
	if count > 0 {
		return nil
	}
	if err := validateAccountInput(input.Email, input.Name, input.Password, input.Roles); err != nil {
		return fmt.Errorf("bootstrap admin: %w", err)
	}
	teamName := strings.TrimSpace(input.Team)
	if teamName == "" || len(teamName) > 120 {
		return errors.New("bootstrap admin: team name is required and must not exceed 120 characters")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash bootstrap password: %w", err)
	}
	roles, err := encodeRoles(input.Roles)
	if err != nil {
		return err
	}
	userID, err := randomID()
	if err != nil {
		return err
	}
	teamID, err := randomID()
	if err != nil {
		return err
	}
	now := time.Now().Unix()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin bootstrap transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (id, email, name, password_hash, roles, is_admin, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
		userID, normalizeEmail(input.Email), strings.TrimSpace(input.Name), string(hash), roles, now, now,
	); err != nil {
		return fmt.Errorf("create bootstrap user: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)", teamID, teamName, now); err != nil {
		return fmt.Errorf("create bootstrap team: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO team_members (team_id, user_id, created_at) VALUES (?, ?, ?)", teamID, userID, now); err != nil {
		return fmt.Errorf("add bootstrap membership: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit bootstrap account: %w", err)
	}
	return nil
}

func (s *Store) CreateUser(ctx context.Context, input CreateUserInput) (User, error) {
	if err := validateAccountInput(input.Email, input.Name, input.Password, input.Roles); err != nil {
		return User{}, err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		return User{}, fmt.Errorf("hash password: %w", err)
	}
	roles, err := encodeRoles(input.Roles)
	if err != nil {
		return User{}, err
	}
	id, err := randomID()
	if err != nil {
		return User{}, err
	}
	now := time.Now()
	admin := 0
	if input.IsAdmin {
		admin = 1
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO users (id, email, name, password_hash, roles, is_admin, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, normalizeEmail(input.Email), strings.TrimSpace(input.Name), string(hash), roles, admin, now.Unix(), now.Unix(),
	)
	if err != nil {
		if isUniqueError(err) {
			return User{}, ErrConflict
		}
		return User{}, fmt.Errorf("create user: %w", err)
	}
	return User{
		ID: id, Email: normalizeEmail(input.Email), Name: strings.TrimSpace(input.Name),
		Roles: normalizedRoles(input.Roles), IsAdmin: input.IsAdmin, Teams: []Team{}, CreatedAt: now,
	}, nil
}

func (s *Store) Authenticate(ctx context.Context, email, password string) (User, error) {
	var user User
	var hash string
	var roles string
	var admin int
	var disabled int
	var createdAt int64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, email, name, password_hash, roles, is_admin, disabled, created_at
		FROM users WHERE email = ? COLLATE NOCASE`,
		normalizeEmail(email),
	).Scan(&user.ID, &user.Email, &user.Name, &hash, &roles, &admin, &disabled, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		_ = bcrypt.CompareHashAndPassword([]byte(dummyPasswordHash), []byte(password))
		return User{}, ErrInvalidCredentials
	}
	if err != nil {
		return User{}, fmt.Errorf("load login account: %w", err)
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil || disabled != 0 {
		return User{}, ErrInvalidCredentials
	}
	if err := decodeRoles(roles, &user.Roles); err != nil {
		return User{}, err
	}
	user.IsAdmin = admin != 0
	user.Disabled = disabled != 0
	user.CreatedAt = time.Unix(createdAt, 0)
	user.Teams, err = s.TeamsForUser(ctx, user.ID)
	if err != nil {
		return User{}, err
	}
	return user, nil
}

func (s *Store) GetUser(ctx context.Context, id string) (User, error) {
	var user User
	var roles string
	var admin int
	var disabled int
	var createdAt int64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, email, name, roles, is_admin, disabled, created_at
		FROM users WHERE id = ?`,
		id,
	).Scan(&user.ID, &user.Email, &user.Name, &roles, &admin, &disabled, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("load user: %w", err)
	}
	if err := decodeRoles(roles, &user.Roles); err != nil {
		return User{}, err
	}
	user.IsAdmin = admin != 0
	user.Disabled = disabled != 0
	user.CreatedAt = time.Unix(createdAt, 0)
	user.Teams, err = s.TeamsForUser(ctx, user.ID)
	if err != nil {
		return User{}, err
	}
	return user, nil
}

func (s *Store) FindUser(ctx context.Context, identifier string) (User, error) {
	var id string
	err := s.db.QueryRowContext(ctx, "SELECT id FROM users WHERE id = ? OR email = ? COLLATE NOCASE", identifier, normalizeEmail(identifier)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("find user: %w", err)
	}
	return s.GetUser(ctx, id)
}

func (s *Store) UpdatePassword(ctx context.Context, userID, currentPassword, newPassword string) error {
	if len(newPassword) < 12 || len(newPassword) > 128 {
		return errors.New("new password must contain between 12 and 128 characters")
	}
	var currentHash string
	if err := s.db.QueryRowContext(ctx, "SELECT password_hash FROM users WHERE id = ? AND disabled = 0", userID).Scan(&currentHash); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrInvalidCredentials
		}
		return fmt.Errorf("load current password: %w", err)
	}
	if bcrypt.CompareHashAndPassword([]byte(currentHash), []byte(currentPassword)) != nil {
		return ErrInvalidCredentials
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash new password: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", string(hash), time.Now().Unix(), userID); err != nil {
		return fmt.Errorf("update password: %w", err)
	}
	return nil
}

func (s *Store) CreateTeam(ctx context.Context, name string) (Team, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 {
		return Team{}, errors.New("team name is required and must not exceed 120 characters")
	}
	id, err := randomID()
	if err != nil {
		return Team{}, err
	}
	_, err = s.db.ExecContext(ctx, "INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)", id, name, time.Now().Unix())
	if err != nil {
		if isUniqueError(err) {
			return Team{}, ErrConflict
		}
		return Team{}, fmt.Errorf("create team: %w", err)
	}
	return Team{ID: id, Name: name}, nil
}

func (s *Store) AddTeamMember(ctx context.Context, teamID, userID string) error {
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO team_members (team_id, user_id, created_at)
		SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM teams WHERE id = ?) AND EXISTS (SELECT 1 FROM users WHERE id = ?)`,
		teamID, userID, time.Now().Unix(), teamID, userID,
	)
	if err != nil {
		if isUniqueError(err) {
			return ErrConflict
		}
		return fmt.Errorf("add team member: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("check team membership: %w", err)
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RemoveTeamMember(ctx context.Context, teamID, userID string) error {
	result, err := s.db.ExecContext(ctx, "DELETE FROM team_members WHERE team_id = ? AND user_id = ?", teamID, userID)
	if err != nil {
		return fmt.Errorf("remove team member: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("check removed membership: %w", err)
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) TeamsForUser(ctx context.Context, userID string) ([]Team, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT teams.id, teams.name
		FROM teams JOIN team_members ON team_members.team_id = teams.id
		WHERE team_members.user_id = ?
		ORDER BY teams.name COLLATE NOCASE`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("list user teams: %w", err)
	}
	defer rows.Close()
	teams := []Team{}
	for rows.Next() {
		var team Team
		if err := rows.Scan(&team.ID, &team.Name); err != nil {
			return nil, fmt.Errorf("scan user team: %w", err)
		}
		teams = append(teams, team)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate user teams: %w", err)
	}
	return teams, nil
}

func (s *Store) TeamForMember(ctx context.Context, teamID, userID string) (Team, error) {
	var team Team
	err := s.db.QueryRowContext(ctx, `
		SELECT teams.id, teams.name
		FROM teams JOIN team_members ON team_members.team_id = teams.id
		WHERE teams.id = ? AND team_members.user_id = ?`,
		teamID, userID,
	).Scan(&team.ID, &team.Name)
	if errors.Is(err, sql.ErrNoRows) {
		return Team{}, ErrNotFound
	}
	if err != nil {
		return Team{}, fmt.Errorf("load team membership: %w", err)
	}
	return team, nil
}

func (s *Store) ListDirectory(ctx context.Context) (Directory, error) {
	directory := Directory{Users: []User{}, Teams: []Team{}, Memberships: []Membership{}}
	userRows, err := s.db.QueryContext(ctx, "SELECT id, email, name, roles, is_admin, disabled, created_at FROM users ORDER BY email COLLATE NOCASE")
	if err != nil {
		return Directory{}, fmt.Errorf("list users: %w", err)
	}
	for userRows.Next() {
		var user User
		var roles string
		var admin int
		var disabled int
		var createdAt int64
		if err := userRows.Scan(&user.ID, &user.Email, &user.Name, &roles, &admin, &disabled, &createdAt); err != nil {
			_ = userRows.Close()
			return Directory{}, fmt.Errorf("scan user: %w", err)
		}
		if err := decodeRoles(roles, &user.Roles); err != nil {
			_ = userRows.Close()
			return Directory{}, err
		}
		user.IsAdmin = admin != 0
		user.Disabled = disabled != 0
		user.CreatedAt = time.Unix(createdAt, 0)
		user.Teams = []Team{}
		directory.Users = append(directory.Users, user)
	}
	if err := userRows.Close(); err != nil {
		return Directory{}, fmt.Errorf("close user list: %w", err)
	}

	teamRows, err := s.db.QueryContext(ctx, "SELECT id, name FROM teams ORDER BY name COLLATE NOCASE")
	if err != nil {
		return Directory{}, fmt.Errorf("list teams: %w", err)
	}
	for teamRows.Next() {
		var team Team
		if err := teamRows.Scan(&team.ID, &team.Name); err != nil {
			_ = teamRows.Close()
			return Directory{}, fmt.Errorf("scan team: %w", err)
		}
		directory.Teams = append(directory.Teams, team)
	}
	if err := teamRows.Close(); err != nil {
		return Directory{}, fmt.Errorf("close team list: %w", err)
	}

	memberRows, err := s.db.QueryContext(ctx, "SELECT user_id, team_id FROM team_members ORDER BY user_id, team_id")
	if err != nil {
		return Directory{}, fmt.Errorf("list memberships: %w", err)
	}
	defer memberRows.Close()
	for memberRows.Next() {
		var membership Membership
		if err := memberRows.Scan(&membership.UserID, &membership.TeamID); err != nil {
			return Directory{}, fmt.Errorf("scan membership: %w", err)
		}
		directory.Memberships = append(directory.Memberships, membership)
	}
	if err := memberRows.Err(); err != nil {
		return Directory{}, fmt.Errorf("iterate memberships: %w", err)
	}
	return directory, nil
}

func validateAccountInput(email, name, password string, roles []string) error {
	email = normalizeEmail(email)
	if !strings.Contains(email, "@") || len(email) > 320 {
		return errors.New("a valid email address is required")
	}
	if strings.TrimSpace(name) == "" || len(strings.TrimSpace(name)) > 120 {
		return errors.New("name is required and must not exceed 120 characters")
	}
	if len(password) < 12 || len(password) > 128 {
		return errors.New("password must contain between 12 and 128 characters")
	}
	for _, role := range roles {
		if strings.TrimSpace(role) == "" || len(role) > 120 {
			return errors.New("roles must be non-empty and must not exceed 120 characters")
		}
	}
	return nil
}

func normalizeEmail(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizedRoles(roles []string) []string {
	roles = slices.Clone(roles)
	for i := range roles {
		roles[i] = strings.TrimSpace(roles[i])
	}
	slices.Sort(roles)
	return slices.Compact(roles)
}

func encodeRoles(roles []string) (string, error) {
	value, err := json.Marshal(normalizedRoles(roles))
	if err != nil {
		return "", fmt.Errorf("encode user roles: %w", err)
	}
	return string(value), nil
}

func decodeRoles(value string, roles *[]string) error {
	if err := json.Unmarshal([]byte(value), roles); err != nil {
		return fmt.Errorf("decode user roles: %w", err)
	}
	if *roles == nil {
		*roles = []string{}
	}
	return nil
}

func isUniqueError(err error) bool {
	return strings.Contains(strings.ToLower(err.Error()), "unique")
}
