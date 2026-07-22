package config

import (
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
	Limits  LimitsConfig   `yaml:"limits"`
	Sources []SourceConfig `yaml:"sources"`
}

type ServerConfig struct {
	Listen      string `yaml:"listen"`
	ExternalURL string `yaml:"external_url"`
}

type AuthConfig struct {
	DevMode          bool                `yaml:"dev_mode"`
	DevUser          DevUserConfig       `yaml:"dev_user"`
	IssuerURL        string              `yaml:"issuer_url"`
	ClientID         string              `yaml:"client_id"`
	ClientSecretEnv  string              `yaml:"client_secret_env"`
	RedirectURL      string              `yaml:"redirect_url"`
	Scopes           []string            `yaml:"scopes"`
	GroupsClaim      string              `yaml:"groups_claim"`
	GroupRoleMap     map[string][]string `yaml:"group_role_map"`
	SessionSecretEnv string              `yaml:"session_secret_env"`
	SessionTTL       Duration            `yaml:"session_ttl"`
}

type DevUserConfig struct {
	Subject string   `yaml:"subject"`
	Email   string   `yaml:"email"`
	Name    string   `yaml:"name"`
	Roles   []string `yaml:"roles"`
}

type LimitsConfig struct {
	QueryTimeout      Duration `yaml:"query_timeout"`
	MaxRows           int      `yaml:"max_rows"`
	MaxBytes          int64    `yaml:"max_bytes"`
	MaxQueriesPerUser int      `yaml:"max_queries_per_user"`
	MaxTailsPerUser   int      `yaml:"max_tails_per_user"`
	MaxLineBytes      int      `yaml:"max_line_bytes"`
}

type SourceConfig struct {
	ID           string       `yaml:"id"`
	Name         string       `yaml:"name"`
	URL          string       `yaml:"url"`
	Roles        []string     `yaml:"roles"`
	Tenants      []Tenant     `yaml:"tenants"`
	Auth         UpstreamAuth `yaml:"auth"`
	HiddenFields []string     `yaml:"hidden_fields"`
}

type Tenant struct {
	AccountID string   `yaml:"account_id" json:"accountId"`
	ProjectID string   `yaml:"project_id" json:"projectId"`
	Name      string   `yaml:"name" json:"name"`
	Roles     []string `yaml:"roles" json:"-"`
}

func (t Tenant) Key() string { return t.AccountID + ":" + t.ProjectID }

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
	if err := yaml.Unmarshal(contents, &cfg); err != nil {
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
	if cfg.Auth.GroupsClaim == "" {
		cfg.Auth.GroupsClaim = "groups"
	}
	if len(cfg.Auth.Scopes) == 0 {
		cfg.Auth.Scopes = []string{"openid", "profile", "email", "groups"}
	}
	if cfg.Auth.SessionSecretEnv == "" {
		cfg.Auth.SessionSecretEnv = "VESTA_SESSION_SECRET"
	}
	if cfg.Auth.SessionTTL.Duration == 0 {
		cfg.Auth.SessionTTL.Duration = time.Hour
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
	if cfg.Limits.MaxTailsPerUser == 0 {
		cfg.Limits.MaxTailsPerUser = 2
	}
	if cfg.Limits.MaxLineBytes == 0 {
		cfg.Limits.MaxLineBytes = 8 << 20
	}
	if cfg.Auth.DevUser.Subject == "" {
		cfg.Auth.DevUser = DevUserConfig{Subject: "dev-user", Email: "dev@localhost", Name: "Developer", Roles: []string{"dev"}}
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
	if !cfg.Auth.DevMode {
		if ext.Scheme != "https" {
			return errors.New("server.external_url must use HTTPS when dev_mode is false")
		}
		if cfg.Auth.IssuerURL == "" || cfg.Auth.ClientID == "" || cfg.Auth.ClientSecretEnv == "" || cfg.Auth.RedirectURL == "" {
			return errors.New("auth issuer_url, client_id, client_secret_env, and redirect_url are required when dev_mode is false")
		}
		issuer, issuerErr := url.Parse(cfg.Auth.IssuerURL)
		redirect, redirectErr := url.Parse(cfg.Auth.RedirectURL)
		if issuerErr != nil || issuer.Scheme != "https" || issuer.Host == "" {
			return errors.New("auth.issuer_url must be an absolute HTTPS URL")
		}
		if redirectErr != nil || !slices.Contains([]string{"http", "https"}, redirect.Scheme) || redirect.Host == "" {
			return errors.New("auth.redirect_url must be an absolute HTTP(S) URL")
		}
		if !strings.EqualFold(redirect.Scheme, ext.Scheme) || !strings.EqualFold(redirect.Host, ext.Host) {
			return errors.New("auth.redirect_url must use the same origin as server.external_url")
		}
		if os.Getenv(cfg.Auth.ClientSecretEnv) == "" {
			return fmt.Errorf("environment variable %s is required", cfg.Auth.ClientSecretEnv)
		}
	}
	secret := os.Getenv(cfg.Auth.SessionSecretEnv)
	if secret == "" && !cfg.Auth.DevMode {
		return fmt.Errorf("environment variable %s is required", cfg.Auth.SessionSecretEnv)
	}
	if secret != "" {
		decoded, decodeErr := base64.StdEncoding.DecodeString(secret)
		if decodeErr != nil || len(decoded) < 32 {
			return fmt.Errorf("%s must contain at least 32 base64-encoded bytes", cfg.Auth.SessionSecretEnv)
		}
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
		if len(source.Roles) == 0 || len(source.Tenants) == 0 {
			return fmt.Errorf("source %q requires at least one access role and tenant", source.ID)
		}
		seenTenants := map[string]struct{}{}
		for j := range source.Tenants {
			tenant := &source.Tenants[j]
			if tenant.AccountID == "" || tenant.ProjectID == "" {
				return fmt.Errorf("source %q tenant %d requires account_id and project_id", source.ID, j)
			}
			if tenant.Name == "" {
				tenant.Name = tenant.Key()
			}
			if _, exists := seenTenants[tenant.Key()]; exists {
				return fmt.Errorf("source %q has duplicate tenant %q", source.ID, tenant.Key())
			}
			seenTenants[tenant.Key()] = struct{}{}
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
	if value := os.Getenv(cfg.Auth.SessionSecretEnv); value != "" {
		decoded, _ := base64.StdEncoding.DecodeString(value)
		return decoded
	}
	return []byte("vesta-development-session-secret-change-me")
}

func (cfg *Config) ClientSecret() string { return os.Getenv(cfg.Auth.ClientSecretEnv) }

func (source SourceConfig) Credentials() (username, password, token string) {
	return os.Getenv(source.Auth.UsernameEnv), os.Getenv(source.Auth.PasswordEnv), os.Getenv(source.Auth.TokenEnv)
}
