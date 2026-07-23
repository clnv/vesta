package auth

import (
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vesta-explorer/vesta/internal/config"
	"github.com/vesta-explorer/vesta/internal/storage"
)

func testAuthenticator(t *testing.T) (*Authenticator, *storage.Store) {
	t.Helper()
	t.Setenv("TEST_VESTA_SESSION", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	cfg := &config.Config{
		Server: config.ServerConfig{ExternalURL: "https://logs.example.test"},
		Auth: config.AuthConfig{
			SessionSecretEnv: "TEST_VESTA_SESSION",
			SessionTTL:       config.Duration{Duration: time.Hour},
		},
	}
	store, err := storage.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.EnsureBootstrapAdmin(t.Context(), storage.BootstrapUser{
		Email: "admin@example.test", Name: "Admin", Password: "correct-horse-battery",
		Team: "Platform", Roles: []string{"reader"},
	}); err != nil {
		t.Fatal(err)
	}
	return New(cfg, store, slog.New(slog.NewTextHandler(io.Discard, nil))), store
}

func TestPasswordLoginLoadsCurrentSQLiteUser(t *testing.T) {
	authenticator, _ := testAuthenticator(t)

	bad := httptest.NewRecorder()
	authenticator.Login(bad, httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"email":"admin@example.test","password":"wrong"}`)))
	if bad.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password status = %d", bad.Code)
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"email":"ADMIN@example.test","password":"correct-horse-battery"}`))
	request.Header.Set("Origin", "https://logs.example.test")
	authenticator.Login(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("login status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	cookies := recorder.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatalf("session cookie is not hardened: %#v", cookies)
	}

	currentRequest := httptest.NewRequest(http.MethodGet, "/api/v1/session", nil)
	currentRequest.AddCookie(cookies[0])
	user, ok := authenticator.Current(currentRequest)
	if !ok || user.Email != "admin@example.test" || !user.IsAdmin || len(user.Teams) != 1 || user.Teams[0].Name != "Platform" {
		t.Fatalf("unexpected current user: %#v, ok=%v", user, ok)
	}
}

func TestExpiredSessionAndCSRF(t *testing.T) {
	authenticator, _ := testAuthenticator(t)
	expired := sessionClaims{
		UserID: "missing", CSRF: "csrf-token", Expires: time.Now().Add(-time.Minute).Unix(),
	}
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
	request.Header.Set("X-CSRF-Token", "wrong")
	if err := authenticator.CheckCSRF(request, user); err == nil {
		t.Fatal("invalid CSRF token was accepted")
	}
}
