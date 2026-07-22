package config

import (
	"encoding/base64"
	"strings"
	"testing"
)

func validProductionConfig(t *testing.T) *Config {
	t.Helper()
	t.Setenv("TEST_VESTA_SESSION", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	t.Setenv("TEST_VESTA_CLIENT", "oidc-client-secret")
	t.Setenv("TEST_VESTA_TOKEN", "victorialogs-token")
	return &Config{
		Server: ServerConfig{ExternalURL: "https://logs.example.test"},
		Auth: AuthConfig{
			IssuerURL: "https://identity.example.test", ClientID: "vesta",
			ClientSecretEnv: "TEST_VESTA_CLIENT", RedirectURL: "https://logs.example.test/auth/callback",
			SessionSecretEnv: "TEST_VESTA_SESSION",
		},
		Sources: []SourceConfig{{
			ID: "prod", Name: "Production", URL: "https://victoria.example.test", Roles: []string{"reader"},
			Tenants: []Tenant{{AccountID: "1", ProjectID: "2"}},
			Auth:    UpstreamAuth{Type: "bearer", TokenEnv: "TEST_VESTA_TOKEN"}, HiddenFields: []string{"password*"},
		}},
	}
}

func TestValidateProductionSecretsAndOrigins(t *testing.T) {
	cfg := validProductionConfig(t)
	if err := cfg.Validate(); err != nil {
		t.Fatalf("valid configuration rejected: %v", err)
	}

	t.Run("missing OIDC secret", func(t *testing.T) {
		copy := *cfg
		copy.Auth = cfg.Auth
		copy.Auth.ClientSecretEnv = "TEST_VESTA_MISSING_CLIENT"
		if err := copy.Validate(); err == nil || !strings.Contains(err.Error(), "TEST_VESTA_MISSING_CLIENT") {
			t.Fatalf("expected missing client secret error, got %v", err)
		}
	})

	t.Run("cross-origin callback", func(t *testing.T) {
		copy := *cfg
		copy.Auth = cfg.Auth
		copy.Auth.RedirectURL = "https://attacker.example.test/callback"
		if err := copy.Validate(); err == nil || !strings.Contains(err.Error(), "same origin") {
			t.Fatalf("expected callback origin error, got %v", err)
		}
	})

	t.Run("insecure production origin", func(t *testing.T) {
		copy := *cfg
		copy.Server.ExternalURL = "http://logs.example.test"
		if err := copy.Validate(); err == nil || !strings.Contains(err.Error(), "must use HTTPS") {
			t.Fatalf("expected HTTPS requirement, got %v", err)
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
}
