package config

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server  ServerConfig   `yaml:"server"`
	Auth    AuthConfig     `yaml:"auth"`
	Storage StorageConfig  `yaml:"storage"`
	Limits  LimitsConfig   `yaml:"limits"`
	Sources []SourceConfig `yaml:"sources"`
}

type ServerConfig struct {
	Listen      string `yaml:"listen"`
	ExternalURL string `yaml:"external_url"`
}

type AuthConfig struct {
	SessionSecretEnv string              `yaml:"session_secret_env"`
	SessionTTL       Duration            `yaml:"session_ttl"`
	Bootstrap        BootstrapUserConfig `yaml:"bootstrap"`
}

type StorageConfig struct {
	Path     string   `yaml:"path"`
	ShareTTL Duration `yaml:"share_ttl"`
}

type BootstrapUserConfig struct {
	Email       string   `yaml:"email"`
	Name        string   `yaml:"name"`
	PasswordEnv string   `yaml:"password_env"`
	Team        string   `yaml:"team"`
	Roles       []string `yaml:"roles"`
}

type LimitsConfig struct {
	QueryTimeout      Duration `yaml:"query_timeout"`
	MaxRows           int      `yaml:"max_rows"`
	MaxBytes          int64    `yaml:"max_bytes"`
	MaxQueriesPerUser int      `yaml:"max_queries_per_user"`
	MaxLineBytes      int      `yaml:"max_line_bytes"`
}

type SourceConfig struct {
	ID           string       `yaml:"id"`
	Name         string       `yaml:"name"`
	URL          string       `yaml:"url"`
	Roles        []string     `yaml:"roles"`
	AccountID    string       `yaml:"account_id"`
	ProjectID    string       `yaml:"project_id"`
	Auth         UpstreamAuth `yaml:"auth"`
	HiddenFields []string     `yaml:"hidden_fields"`
}

type UpstreamAuth struct {
	Type        string `yaml:"type"`
	UsernameEnv string `yaml:"username_env"`
	PasswordEnv string `yaml:"password_env"`
	TokenEnv    string `yaml:"token_env"`
}

type Duration struct{ time.Duration }

func (d *Duration) UnmarshalYAML(value *yaml.Node) error {
	parsed, err := time.ParseDuration(value.Value)
	if err != nil {
		return err
	}
	d.Duration = parsed
	return nil
}

func Load(path string) (*Config, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	decoder := yaml.NewDecoder(bytes.NewReader(contents))
	decoder.KnownFields(true)
	if err := decoder.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("parse configuration: %w", err)
	}
	applyDefaults(&cfg)
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func applyDefaults(cfg *Config) {
	if cfg.Server.Listen == "" {
		cfg.Server.Listen = ":8080"
	}
	if cfg.Auth.SessionSecretEnv == "" {
		cfg.Auth.SessionSecretEnv = "VESTA_SESSION_SECRET"
	}
	if cfg.Auth.SessionTTL.Duration == 0 {
		cfg.Auth.SessionTTL.Duration = time.Hour
	}
	if cfg.Auth.Bootstrap.Email == "" {
		cfg.Auth.Bootstrap.Email = "admin@localhost"
	}
	if cfg.Auth.Bootstrap.Name == "" {
		cfg.Auth.Bootstrap.Name = "Administrator"
	}
	if cfg.Auth.Bootstrap.PasswordEnv == "" {
		cfg.Auth.Bootstrap.PasswordEnv = "VESTA_BOOTSTRAP_PASSWORD"
	}
	if cfg.Auth.Bootstrap.Team == "" {
		cfg.Auth.Bootstrap.Team = "Administrators"
	}
	if len(cfg.Auth.Bootstrap.Roles) == 0 {
		cfg.Auth.Bootstrap.Roles = []string{"reader"}
	}
	if cfg.Storage.Path == "" {
		cfg.Storage.Path = "data/vesta.db"
	}
	if cfg.Storage.ShareTTL.Duration == 0 {
		cfg.Storage.ShareTTL.Duration = 7 * 24 * time.Hour
	}
	if cfg.Limits.QueryTimeout.Duration == 0 {
		cfg.Limits.QueryTimeout.Duration = 30 * time.Second
	}
	if cfg.Limits.MaxRows == 0 {
		cfg.Limits.MaxRows = 50_000
	}
	if cfg.Limits.MaxBytes == 0 {
		cfg.Limits.MaxBytes = 32 << 20
	}
	if cfg.Limits.MaxQueriesPerUser == 0 {
		cfg.Limits.MaxQueriesPerUser = 4
	}
	if cfg.Limits.MaxLineBytes == 0 {
		cfg.Limits.MaxLineBytes = 8 << 20
	}
}

func (cfg *Config) Validate() error {
	if len(cfg.Sources) == 0 {
		return errors.New("at least one VictoriaLogs source is required")
	}
	if cfg.Server.ExternalURL == "" {
		return errors.New("server.external_url is required")
	}
	ext, err := url.Parse(cfg.Server.ExternalURL)
	if err != nil || !slices.Contains([]string{"http", "https"}, ext.Scheme) || ext.Host == "" {
		return errors.New("server.external_url must be an absolute HTTP(S) URL")
	}
	if !strings.Contains(cfg.Auth.Bootstrap.Email, "@") || len(cfg.Auth.Bootstrap.Email) > 320 {
		return errors.New("auth.bootstrap.email must be a valid email address")
	}
	if strings.TrimSpace(cfg.Auth.Bootstrap.Name) == "" || cfg.Auth.Bootstrap.PasswordEnv == "" || strings.TrimSpace(cfg.Auth.Bootstrap.Team) == "" {
		return errors.New("auth.bootstrap name, password_env, and team are required")
	}
	for _, role := range cfg.Auth.Bootstrap.Roles {
		if strings.TrimSpace(role) == "" {
			return errors.New("auth.bootstrap.roles cannot contain an empty role")
		}
	}
	secret := os.Getenv(cfg.Auth.SessionSecretEnv)
	if secret == "" {
		return fmt.Errorf("environment variable %s is required", cfg.Auth.SessionSecretEnv)
	}
	decoded, decodeErr := base64.StdEncoding.DecodeString(secret)
	if decodeErr != nil || len(decoded) < 32 {
		return fmt.Errorf("%s must contain at least 32 base64-encoded bytes", cfg.Auth.SessionSecretEnv)
	}
	if strings.TrimSpace(cfg.Storage.Path) == "" {
		return errors.New("storage.path is required")
	}
	if cfg.Storage.ShareTTL.Duration < 0 {
		return errors.New("storage.share_ttl must be greater than zero")
	}

	ids := map[string]struct{}{}
	for i := range cfg.Sources {
		source := &cfg.Sources[i]
		if source.ID == "" || source.Name == "" || source.URL == "" {
			return fmt.Errorf("source %d requires id, name, and url", i)
		}
		if _, exists := ids[source.ID]; exists {
			return fmt.Errorf("duplicate source id %q", source.ID)
		}
		ids[source.ID] = struct{}{}
		parsed, parseErr := url.Parse(source.URL)
		if parseErr != nil || !slices.Contains([]string{"http", "https"}, parsed.Scheme) || parsed.Host == "" {
			return fmt.Errorf("source %q has an invalid url", source.ID)
		}
		source.URL = strings.TrimRight(source.URL, "/")
		if len(source.Roles) == 0 {
			return fmt.Errorf("source %q requires at least one access role", source.ID)
		}
		if (source.AccountID == "") != (source.ProjectID == "") {
			return fmt.Errorf("source %q must set both account_id and project_id or neither", source.ID)
		}
		if err := validateUpstreamAuth(*source); err != nil {
			return err
		}
		for _, pattern := range source.HiddenFields {
			if pattern == "" {
				return fmt.Errorf("source %q contains an empty hidden field pattern", source.ID)
			}
			if strings.Count(pattern, "*") > 1 || strings.Contains(pattern, "*") && !strings.HasSuffix(pattern, "*") {
				return fmt.Errorf("source %q hidden field pattern %q must be an exact name or end in a single *", source.ID, pattern)
			}
		}
	}
	return nil
}

func validateUpstreamAuth(source SourceConfig) error {
	switch source.Auth.Type {
	case "", "none":
		return nil
	case "basic":
		if source.Auth.UsernameEnv == "" || source.Auth.PasswordEnv == "" {
			return fmt.Errorf("source %q basic auth requires username_env and password_env", source.ID)
		}
		if os.Getenv(source.Auth.UsernameEnv) == "" || os.Getenv(source.Auth.PasswordEnv) == "" {
			return fmt.Errorf("source %q basic auth credential environment variables must be set", source.ID)
		}
	case "bearer":
		if source.Auth.TokenEnv == "" {
			return fmt.Errorf("source %q bearer auth requires token_env", source.ID)
		}
		if os.Getenv(source.Auth.TokenEnv) == "" {
			return fmt.Errorf("environment variable %s is required for source %q", source.Auth.TokenEnv, source.ID)
		}
	default:
		return fmt.Errorf("source %q has unsupported auth type %q", source.ID, source.Auth.Type)
	}
	return nil
}

func (cfg *Config) SessionSecret() []byte {
	decoded, _ := base64.StdEncoding.DecodeString(os.Getenv(cfg.Auth.SessionSecretEnv))
	return decoded
}

func (cfg *Config) BootstrapPassword() string { return os.Getenv(cfg.Auth.Bootstrap.PasswordEnv) }

func (source SourceConfig) Credentials() (username, password, token string) {
	return os.Getenv(source.Auth.UsernameEnv), os.Getenv(source.Auth.PasswordEnv), os.Getenv(source.Auth.TokenEnv)
}
