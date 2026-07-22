package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gorilla/securecookie"
	"github.com/vesta-explorer/vesta/internal/config"
	"golang.org/x/oauth2"
)

const (
	sessionCookie = "vesta_session"
	flowCookie    = "vesta_oidc_flow"
)

type User struct {
	Subject string   `json:"subject"`
	Email   string   `json:"email"`
	Name    string   `json:"name"`
	Roles   []string `json:"roles"`
	CSRF    string   `json:"csrf"`
	Expires int64    `json:"expires"`
}

type flowState struct {
	State    string `json:"state"`
	Nonce    string `json:"nonce"`
	Verifier string `json:"verifier"`
	Expires  int64  `json:"expires"`
}

type Authenticator struct {
	cfg          *config.Config
	logger       *slog.Logger
	secureCookie *securecookie.SecureCookie
	provider     *oidc.Provider
	oauth        oauth2.Config
	verifier     *oidc.IDTokenVerifier
	secure       bool
}

func New(ctx context.Context, cfg *config.Config, logger *slog.Logger) (*Authenticator, error) {
	secret := cfg.SessionSecret()
	hash := sha256.Sum256(append([]byte("vesta-cookie-auth:"), secret...))
	block := sha256.Sum256(append([]byte("vesta-cookie-encryption:"), secret...))
	sc := securecookie.New(hash[:], block[:])
	sc.SetSerializer(securecookie.JSONEncoder{})
	sc.MaxAge(int(cfg.Auth.SessionTTL.Duration.Seconds()))

	ext, _ := url.Parse(cfg.Server.ExternalURL)
	a := &Authenticator{cfg: cfg, logger: logger, secureCookie: sc, secure: ext.Scheme == "https"}
	if cfg.Auth.DevMode {
		return a, nil
	}

	provider, err := oidc.NewProvider(ctx, cfg.Auth.IssuerURL)
	if err != nil {
		return nil, fmt.Errorf("discover OIDC provider: %w", err)
	}
	a.provider = provider
	a.verifier = provider.Verifier(&oidc.Config{ClientID: cfg.Auth.ClientID})
	a.oauth = oauth2.Config{
		ClientID:     cfg.Auth.ClientID,
		ClientSecret: cfg.ClientSecret(),
		Endpoint:     provider.Endpoint(),
		RedirectURL:  cfg.Auth.RedirectURL,
		Scopes:       cfg.Auth.Scopes,
	}
	return a, nil
}

func (a *Authenticator) Current(r *http.Request) (User, bool) {
	if a.cfg.Auth.DevMode {
		return User{
			Subject: a.cfg.Auth.DevUser.Subject,
			Email:   a.cfg.Auth.DevUser.Email,
			Name:    a.cfg.Auth.DevUser.Name,
			Roles:   slices.Clone(a.cfg.Auth.DevUser.Roles),
			CSRF:    "vesta-development-csrf",
			Expires: time.Now().Add(24 * time.Hour).Unix(),
		}, true
	}
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return User{}, false
	}
	var user User
	if err := a.secureCookie.Decode(sessionCookie, cookie.Value, &user); err != nil || user.Subject == "" || user.Expires <= time.Now().Unix() {
		return User{}, false
	}
	return user, true
}

func (a *Authenticator) Login(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Auth.DevMode {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	state, err := randomURLSafe(32)
	if err != nil {
		http.Error(w, "could not start authentication", http.StatusInternalServerError)
		return
	}
	nonce, err := randomURLSafe(32)
	if err != nil {
		http.Error(w, "could not start authentication", http.StatusInternalServerError)
		return
	}
	verifier, err := randomURLSafe(48)
	if err != nil {
		http.Error(w, "could not start authentication", http.StatusInternalServerError)
		return
	}
	flow := flowState{State: state, Nonce: nonce, Verifier: verifier, Expires: time.Now().Add(10 * time.Minute).Unix()}
	encoded, err := a.secureCookie.Encode(flowCookie, flow)
	if err != nil {
		http.Error(w, "could not start authentication", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: flowCookie, Value: encoded, Path: "/auth", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, MaxAge: 600})
	challengeHash := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeHash[:])
	location := a.oauth.AuthCodeURL(
		state,
		oidc.Nonce(nonce),
		oauth2.SetAuthURLParam("code_challenge", challenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
	)
	http.Redirect(w, r, location, http.StatusFound)
}

func (a *Authenticator) Callback(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Auth.DevMode {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	flow, err := a.readFlow(r)
	if err != nil || flow.Expires <= time.Now().Unix() || r.URL.Query().Get("state") != flow.State {
		http.Error(w, "invalid or expired authentication flow", http.StatusBadRequest)
		return
	}
	if oidcError := r.URL.Query().Get("error"); oidcError != "" {
		a.logger.Warn("OIDC callback rejected", "error", oidcError)
		http.Error(w, "authentication was rejected", http.StatusUnauthorized)
		return
	}
	token, err := a.oauth.Exchange(r.Context(), r.URL.Query().Get("code"), oauth2.SetAuthURLParam("code_verifier", flow.Verifier))
	if err != nil {
		a.logger.Warn("OIDC code exchange failed", "error", err)
		http.Error(w, "authentication failed", http.StatusUnauthorized)
		return
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		http.Error(w, "identity provider returned no ID token", http.StatusUnauthorized)
		return
	}
	idToken, err := a.verifier.Verify(r.Context(), rawIDToken)
	if err != nil {
		http.Error(w, "identity token verification failed", http.StatusUnauthorized)
		return
	}
	var claims map[string]any
	if err := idToken.Claims(&claims); err != nil {
		http.Error(w, "identity claims could not be read", http.StatusUnauthorized)
		return
	}
	if nonce, _ := claims["nonce"].(string); nonce != flow.Nonce {
		http.Error(w, "identity nonce mismatch", http.StatusUnauthorized)
		return
	}
	roles := a.rolesFromClaims(claims)
	if len(roles) == 0 {
		http.Error(w, "your account has no Vesta roles", http.StatusForbidden)
		return
	}
	csrf, _ := randomURLSafe(32)
	user := User{
		Subject: stringClaim(claims, "sub"),
		Email:   stringClaim(claims, "email"),
		Name:    firstNonEmpty(stringClaim(claims, "name"), stringClaim(claims, "preferred_username"), stringClaim(claims, "email")),
		Roles:   roles,
		CSRF:    csrf,
		Expires: time.Now().Add(a.cfg.Auth.SessionTTL.Duration).Unix(),
	}
	if user.Subject == "" {
		http.Error(w, "identity token has no subject", http.StatusUnauthorized)
		return
	}
	encoded, err := a.secureCookie.Encode(sessionCookie, user)
	if err != nil {
		http.Error(w, "session could not be created", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: encoded, Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, MaxAge: int(a.cfg.Auth.SessionTTL.Duration.Seconds())})
	http.SetCookie(w, &http.Cookie{Name: flowCookie, Value: "", Path: "/auth", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	http.Redirect(w, r, "/", http.StatusFound)
}

func (a *Authenticator) Logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	http.Redirect(w, r, "/", http.StatusFound)
}

func (a *Authenticator) readFlow(r *http.Request) (flowState, error) {
	cookie, err := r.Cookie(flowCookie)
	if err != nil {
		return flowState{}, err
	}
	var flow flowState
	if err := a.secureCookie.Decode(flowCookie, cookie.Value, &flow); err != nil {
		return flowState{}, err
	}
	return flow, nil
}

func (a *Authenticator) rolesFromClaims(claims map[string]any) []string {
	var groups []string
	switch raw := claims[a.cfg.Auth.GroupsClaim].(type) {
	case []any:
		for _, item := range raw {
			if value, ok := item.(string); ok {
				groups = append(groups, value)
			}
		}
	case []string:
		groups = append(groups, raw...)
	case string:
		groups = append(groups, strings.Fields(raw)...)
	}
	set := map[string]struct{}{}
	for _, group := range groups {
		for _, role := range a.cfg.Auth.GroupRoleMap[group] {
			set[role] = struct{}{}
		}
	}
	roles := make([]string, 0, len(set))
	for role := range set {
		roles = append(roles, role)
	}
	slices.Sort(roles)
	return roles
}

func randomURLSafe(size int) (string, error) {
	bytes := make([]byte, size)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func stringClaim(claims map[string]any, name string) string {
	value, _ := claims[name].(string)
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func (a *Authenticator) CheckCSRF(r *http.Request, user User) error {
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return nil
	}
	if subtleEqual(r.Header.Get("X-CSRF-Token"), user.CSRF) == false {
		return errors.New("invalid CSRF token")
	}
	if a.cfg.Auth.DevMode {
		return nil
	}
	origin := r.Header.Get("Origin")
	expected, _ := url.Parse(a.cfg.Server.ExternalURL)
	actual, err := url.Parse(origin)
	if origin == "" || err != nil || !strings.EqualFold(actual.Scheme, expected.Scheme) || !strings.EqualFold(actual.Host, expected.Host) {
		return errors.New("invalid request origin")
	}
	return nil
}

func subtleEqual(a, b string) bool {
	if len(a) != len(b) || a == "" {
		return false
	}
	var different byte
	for i := range len(a) {
		different |= a[i] ^ b[i]
	}
	return different == 0
}
