package config

import (
	"encoding/base64"
	"strings"
	"testing"
)

func validProductionConfig(t *testing.T) *Config {
	t.Helper()
	t.Setenv("TEST_VESTA_SESSION", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	t.Setenv("TEST_VESTA_TOKEN", "victorialogs-token")
	return &Config{
		Server: ServerConfig{ExternalURL: "https://logs.example.test"},
		Auth: AuthConfig{
			SessionSecretEnv: "TEST_VESTA_SESSION",
			Bootstrap: BootstrapUserConfig{
				Email: "admin@example.test", Name: "Admin", PasswordEnv: "TEST_VESTA_BOOTSTRAP",
				Team: "Platform", Roles: []string{"reader"},
			},
		},
		Storage: StorageConfig{Path: "/var/lib/vesta/vesta.db"},
		Sources: []SourceConfig{{
			ID: "prod", Name: "Production", URL: "https://victoria.example.test", Roles: []string{"reader"},
			AccountID: "1", ProjectID: "2",
			Auth: UpstreamAuth{Type: "bearer", TokenEnv: "TEST_VESTA_TOKEN"}, HiddenFields: []string{"password*"},
		}},
	}
}

func TestValidateLocalAuthenticationAndSources(t *testing.T) {
	cfg := validProductionConfig(t)
	if err := cfg.Validate(); err != nil {
		t.Fatalf("valid configuration rejected: %v", err)
	}

	t.Run("missing session secret", func(t *testing.T) {
		copy := *cfg
		copy.Auth = cfg.Auth
		copy.Auth.SessionSecretEnv = "TEST_VESTA_MISSING_SESSION"
		if err := copy.Validate(); err == nil || !strings.Contains(err.Error(), "TEST_VESTA_MISSING_SESSION") {
			t.Fatalf("expected missing session secret error, got %v", err)
		}
	})

	t.Run("invalid bootstrap account", func(t *testing.T) {
		copy := *cfg
		copy.Auth = cfg.Auth
		copy.Auth.Bootstrap.Email = "not-an-email"
		if err := copy.Validate(); err == nil || !strings.Contains(err.Error(), "bootstrap.email") {
			t.Fatalf("expected bootstrap email error, got %v", err)
		}
	})

	t.Run("missing upstream token", func(t *testing.T) {
		copy := *cfg
		copy.Sources = append([]SourceConfig(nil), cfg.Sources...)
		copy.Sources[0].Auth.TokenEnv = "TEST_VESTA_MISSING_TOKEN"
		if err := copy.Validate(); err == nil || !strings.Contains(err.Error(), "TEST_VESTA_MISSING_TOKEN") {
			t.Fatalf("expected missing upstream token error, got %v", err)
		}
	})

	t.Run("invalid hidden field pattern", func(t *testing.T) {
		copy := *cfg
		copy.Sources = append([]SourceConfig(nil), cfg.Sources...)
		copy.Sources[0].HiddenFields = []string{"password*copy"}
		if err := copy.Validate(); err == nil || !strings.Contains(err.Error(), "hidden field pattern") {
			t.Fatalf("expected hidden field pattern error, got %v", err)
		}
	})

	t.Run("partial upstream routing", func(t *testing.T) {
		copy := *cfg
		copy.Sources = append([]SourceConfig(nil), cfg.Sources...)
		copy.Sources[0].ProjectID = ""
		if err := copy.Validate(); err == nil || !strings.Contains(err.Error(), "account_id and project_id") {
			t.Fatalf("expected paired routing fields error, got %v", err)
		}
	})

	t.Run("negative share lifetime", func(t *testing.T) {
		copy := *cfg
		copy.Storage.ShareTTL.Duration = -1
		if err := copy.Validate(); err == nil || !strings.Contains(err.Error(), "share_ttl") {
			t.Fatalf("expected share lifetime error, got %v", err)
		}
	})
}

func TestApplyDefaultsForLocalAuth(t *testing.T) {
	cfg := &Config{}
	applyDefaults(cfg)
	if cfg.Auth.Bootstrap.Email != "admin@localhost" || cfg.Auth.Bootstrap.PasswordEnv != "VESTA_BOOTSTRAP_PASSWORD" ||
		cfg.Auth.Bootstrap.Team != "Administrators" || len(cfg.Auth.Bootstrap.Roles) != 1 {
		t.Fatalf("unexpected auth defaults: %#v", cfg.Auth)
	}
	if cfg.Storage.Path != "data/vesta.db" {
		t.Fatalf("storage path = %q", cfg.Storage.Path)
	}
}
