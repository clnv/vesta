package storage

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var ErrShareNotFound = errors.New("share not found")
var ErrNotFound = errors.New("record not found")
var ErrConflict = errors.New("record already exists")
var ErrInvalidCredentials = errors.New("invalid credentials")
var ErrLastAdmin = errors.New("at least one active administrator is required")

type Share struct {
	ID            string
	Payload       []byte
	AudienceType  string
	AudienceValue string
	CreatedBy     string
	CreatedAt     time.Time
	ExpiresAt     time.Time
}

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("SQLite path is required")
	}
	if path != ":memory:" {
		directory := filepath.Dir(path)
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, fmt.Errorf("create SQLite directory: %w", err)
		}
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open SQLite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	store := &Store{db: db}
	if err := store.initialize(context.Background(), path != ":memory:"); err != nil {
		_ = db.Close()
		return nil, err
	}
	if path != ":memory:" {
		if err := os.Chmod(path, 0o600); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("secure SQLite file: %w", err)
		}
	}
	return store, nil
}

func (s *Store) initialize(ctx context.Context, persistent bool) error {
	pragmas := []string{
		"PRAGMA foreign_keys = ON",
		"PRAGMA busy_timeout = 5000",
		"PRAGMA synchronous = NORMAL",
	}
	if persistent {
		pragmas = append(pragmas, "PRAGMA journal_mode = WAL")
	}
	for _, statement := range pragmas {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("configure SQLite: %w", err)
		}
	}
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL COLLATE NOCASE UNIQUE,
			name TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			roles TEXT NOT NULL DEFAULT '[]',
			is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
			disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		) STRICT`,
		`CREATE TABLE IF NOT EXISTS teams (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL COLLATE NOCASE UNIQUE,
			created_at INTEGER NOT NULL
		) STRICT`,
		`CREATE TABLE IF NOT EXISTS team_members (
			team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (team_id, user_id)
		) STRICT`,
		`CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members (user_id, team_id)`,
		`CREATE TABLE IF NOT EXISTS folders (
			id TEXT PRIMARY KEY,
			team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
			name TEXT NOT NULL COLLATE NOCASE,
			created_by TEXT NOT NULL REFERENCES users(id),
			created_at INTEGER NOT NULL,
			UNIQUE (team_id, name)
		) STRICT`,
		`CREATE INDEX IF NOT EXISTS folders_team_idx ON folders (team_id, name)`,
		`CREATE TABLE IF NOT EXISTS team_queries (
			id TEXT PRIMARY KEY,
			team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
			folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
			title TEXT NOT NULL,
			query TEXT NOT NULL,
			source_id TEXT NOT NULL,
			result_mode TEXT NOT NULL CHECK (result_mode IN ('table', 'json', 'chart')),
			created_by TEXT NOT NULL REFERENCES users(id),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		) STRICT`,
		`CREATE INDEX IF NOT EXISTS team_queries_team_folder_idx ON team_queries (team_id, folder_id, updated_at DESC)`,
		`CREATE TABLE IF NOT EXISTS personal_queries (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			title TEXT NOT NULL,
			query TEXT NOT NULL,
			source_id TEXT NOT NULL,
			result_mode TEXT NOT NULL CHECK (result_mode IN ('table', 'json', 'chart')),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		) STRICT`,
		`CREATE INDEX IF NOT EXISTS personal_queries_user_idx ON personal_queries (user_id, updated_at DESC)`,
		`CREATE TABLE IF NOT EXISTS shares (
			id TEXT PRIMARY KEY,
			payload BLOB NOT NULL,
			audience_type TEXT NOT NULL CHECK (audience_type IN ('system', 'user', 'team')),
			audience_value TEXT NOT NULL,
			created_by TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		) STRICT`,
		`CREATE INDEX IF NOT EXISTS shares_expires_at_idx ON shares (expires_at)`,
		`DELETE FROM shares WHERE expires_at <= unixepoch()`,
	} {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize SQLite schema: %w", err)
		}
	}
	if err := s.ensureSystemShareAudience(ctx); err != nil {
		return err
	}
	return nil
}

func (s *Store) ensureSystemShareAudience(ctx context.Context) error {
	var definition string
	if err := s.db.QueryRowContext(ctx, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'shares'").Scan(&definition); err != nil {
		return fmt.Errorf("inspect shares schema: %w", err)
	}
	if strings.Contains(definition, "'system'") {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin shares migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, statement := range []string{
		"ALTER TABLE shares RENAME TO shares_legacy",
		`CREATE TABLE shares (
			id TEXT PRIMARY KEY,
			payload BLOB NOT NULL,
			audience_type TEXT NOT NULL CHECK (audience_type IN ('system', 'user', 'team')),
			audience_value TEXT NOT NULL,
			created_by TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		) STRICT`,
		`INSERT INTO shares (id, payload, audience_type, audience_value, created_by, created_at, expires_at)
		 SELECT id, payload, audience_type, audience_value, created_by, created_at, expires_at FROM shares_legacy`,
		"DROP TABLE shares_legacy",
		"CREATE INDEX shares_expires_at_idx ON shares (expires_at)",
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate shares schema: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit shares migration: %w", err)
	}
	return nil
}

func (s *Store) CreateShare(ctx context.Context, share Share) (string, error) {
	if len(share.Payload) == 0 || share.AudienceValue == "" || share.CreatedBy == "" || share.ExpiresAt.IsZero() {
		return "", errors.New("share record is incomplete")
	}
	if share.AudienceType != "system" && share.AudienceType != "user" && share.AudienceType != "team" {
		return "", errors.New("share audience is invalid")
	}
	if share.CreatedAt.IsZero() {
		share.CreatedAt = time.Now()
	}
	if _, err := s.db.ExecContext(ctx, "DELETE FROM shares WHERE expires_at <= ?", share.CreatedAt.Unix()); err != nil {
		return "", fmt.Errorf("delete expired shares: %w", err)
	}

	for range 3 {
		id, err := randomID()
		if err != nil {
			return "", err
		}
		_, err = s.db.ExecContext(ctx, `
			INSERT INTO shares (
				id, payload, audience_type, audience_value,
				created_by, created_at, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			id, share.Payload, share.AudienceType, share.AudienceValue,
			share.CreatedBy, share.CreatedAt.Unix(), share.ExpiresAt.Unix(),
		)
		if err == nil {
			return id, nil
		}
		if !strings.Contains(strings.ToLower(err.Error()), "unique") {
			return "", fmt.Errorf("insert share: %w", err)
		}
	}
	return "", errors.New("could not allocate a unique share ID")
}

func (s *Store) GetShare(ctx context.Context, id string, now time.Time) (Share, error) {
	var share Share
	var createdAt int64
	var expiresAt int64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, payload, audience_type, audience_value, created_by, created_at, expires_at
		FROM shares
		WHERE id = ? AND expires_at > ?`,
		id, now.Unix(),
	).Scan(
		&share.ID, &share.Payload, &share.AudienceType, &share.AudienceValue,
		&share.CreatedBy, &createdAt, &expiresAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Share{}, ErrShareNotFound
	}
	if err != nil {
		return Share{}, fmt.Errorf("select share: %w", err)
	}
	share.CreatedAt = time.Unix(createdAt, 0)
	share.ExpiresAt = time.Unix(expiresAt, 0)
	return share, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func randomID() (string, error) {
	value := make([]byte, 24)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate share ID: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}
