package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/vesta-explorer/vesta/internal/config"
	"golang.org/x/oauth2"
)

func productionTestAuthenticator(t *testing.T) (*Authenticator, *config.Config) {
	t.Helper()
	cfg := &config.Config{
		Server: config.ServerConfig{ExternalURL: "https://logs.example.test"},
		Auth: config.AuthConfig{
			DevMode: true, SessionTTL: config.Duration{Duration: time.Hour}, GroupsClaim: "groups",
			GroupRoleMap: map[string][]string{"platform": {"reader", "operator"}, "developers": {"reader"}},
		},
	}
	authenticator, err := New(context.Background(), cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	cfg.Auth.DevMode = false
	authenticator.oauth = oauth2.Config{
		ClientID: "vesta", RedirectURL: "https://logs.example.test/auth/callback",
		Endpoint: oauth2.Endpoint{AuthURL: "https://identity.example.test/authorize", TokenURL: "https://identity.example.test/token"},
	}
	return authenticator, cfg
}

func TestLoginUsesStateNonceAndPKCE(t *testing.T) {
	authenticator, _ := productionTestAuthenticator(t)
	recorder := httptest.NewRecorder()
	authenticator.Login(recorder, httptest.NewRequest(http.MethodGet, "/auth/login", nil))
	response := recorder.Result()
	if response.StatusCode != http.StatusFound {
		t.Fatalf("status = %d", response.StatusCode)
	}
	location, err := url.Parse(response.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	cookies := response.Cookies()
	if len(cookies) != 1 || cookies[0].Name != flowCookie {
		t.Fatalf("unexpected cookies: %#v", cookies)
	}
	if !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatalf("flow cookie is not hardened: %#v", cookies[0])
	}
	flowRequest := httptest.NewRequest(http.MethodGet, "/auth/callback", nil)
	flowRequest.AddCookie(cookies[0])
	flow, err := authenticator.readFlow(flowRequest)
	if err != nil {
		t.Fatal(err)
	}
	query := location.Query()
	if query.Get("state") != flow.State || query.Get("nonce") != flow.Nonce || query.Get("code_challenge_method") != "S256" {
		t.Fatalf("missing state, nonce, or PKCE parameters: %v", query)
	}
	digest := sha256.Sum256([]byte(flow.Verifier))
	if query.Get("code_challenge") != base64.RawURLEncoding.EncodeToString(digest[:]) {
		t.Fatal("PKCE challenge does not match the protected verifier")
	}
}

func TestRoleMappingSessionExpiryAndCSRF(t *testing.T) {
	authenticator, _ := productionTestAuthenticator(t)
	roles := authenticator.rolesFromClaims(map[string]any{"groups": []any{"developers", "platform", 42}})
	if len(roles) != 2 || roles[0] != "operator" || roles[1] != "reader" {
		t.Fatalf("roles = %#v", roles)
	}

	expired := User{Subject: "user-1", CSRF: "csrf-token", Expires: time.Now().Add(-time.Minute).Unix()}
	encoded, err := authenticator.secureCookie.Encode(sessionCookie, expired)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/session", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookie, Value: encoded})
	if _, ok := authenticator.Current(request); ok {
		t.Fatal("expired session was accepted")
	}

	user := User{CSRF: "csrf-token"}
	request = httptest.NewRequest(http.MethodPost, "/api/v1/query", nil)
	request.Header.Set("X-CSRF-Token", "csrf-token")
	request.Header.Set("Origin", "https://logs.example.test")
	if err := authenticator.CheckCSRF(request, user); err != nil {
		t.Fatalf("valid CSRF request rejected: %v", err)
	}
	request.Header.Set("Origin", "https://other.example.test")
	if err := authenticator.CheckCSRF(request, user); err == nil {
		t.Fatal("cross-origin request was accepted")
	}
	request.Header.Del("Origin")
	if err := authenticator.CheckCSRF(request, user); err == nil {
		t.Fatal("origin-less production request was accepted")
	}
}
