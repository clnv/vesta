package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/securecookie"
	"github.com/vesta-explorer/vesta/internal/config"
	"github.com/vesta-explorer/vesta/internal/storage"
)

const sessionCookie = "vesta_session"

type Team struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type User struct {
	Subject            string
	Email              string
	Name               string
	Roles              []string
	Teams              []Team
	IsAdmin            bool
	HiddenResultFields []string
	CSRF               string
	Expires            int64
}

type sessionClaims struct {
	UserID  string `json:"userId"`
	CSRF    string `json:"csrf"`
	Expires int64  `json:"expires"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type Authenticator struct {
	cfg          *config.Config
	store        *storage.Store
	logger       *slog.Logger
	secureCookie *securecookie.SecureCookie
	secure       bool
}

func New(cfg *config.Config, store *storage.Store, logger *slog.Logger) *Authenticator {
	secret := cfg.SessionSecret()
	hash := sha256.Sum256(append([]byte("vesta-cookie-auth:"), secret...))
	block := sha256.Sum256(append([]byte("vesta-cookie-encryption:"), secret...))
	sc := securecookie.New(hash[:], block[:])
	sc.SetSerializer(securecookie.JSONEncoder{})
	sc.MaxAge(int(cfg.Auth.SessionTTL.Duration.Seconds()))

	ext, _ := url.Parse(cfg.Server.ExternalURL)
	return &Authenticator{
		cfg: cfg, store: store, logger: logger, secureCookie: sc,
		secure: ext.Scheme == "https",
	}
}

func (a *Authenticator) Current(r *http.Request) (User, bool) {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return User{}, false
	}
	var claims sessionClaims
	if err := a.secureCookie.Decode(sessionCookie, cookie.Value, &claims); err != nil ||
		claims.UserID == "" || claims.CSRF == "" ||
		claims.Expires <= time.Now().Unix() {
		return User{}, false
	}
	account, err := a.store.GetUser(r.Context(), claims.UserID)
	if err != nil || account.Disabled {
		return User{}, false
	}
	settings, err := a.store.GetUserSettings(r.Context(), account.ID)
	if err != nil {
		return User{}, false
	}
	teams := make([]Team, 0, len(account.Teams))
	for _, team := range account.Teams {
		teams = append(teams, Team{ID: team.ID, Name: team.Name})
	}
	return User{
		Subject:            account.ID,
		Email:              account.Email,
		Name:               account.Name,
		Roles:              account.Roles,
		Teams:              teams,
		IsAdmin:            account.IsAdmin,
		HiddenResultFields: settings.HiddenResultFields,
		CSRF:               claims.CSRF,
		Expires:            claims.Expires,
	}, true
}

func (a *Authenticator) Login(w http.ResponseWriter, r *http.Request) {
	if err := a.checkOrigin(r); err != nil {
		writeAuthError(w, http.StatusForbidden, err.Error())
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input loginRequest
	if err := decoder.Decode(&input); err != nil {
		writeAuthError(w, http.StatusBadRequest, "invalid login request")
		return
	}
	if err := ensureJSONEOF(decoder); err != nil {
		writeAuthError(w, http.StatusBadRequest, "invalid login request")
		return
	}
	account, err := a.store.Authenticate(r.Context(), input.Email, input.Password)
	if err != nil {
		if !errors.Is(err, storage.ErrInvalidCredentials) {
			a.logger.Error("local login failed", "error", err)
		}
		writeAuthError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	csrf, err := randomURLSafe(32)
	if err != nil {
		writeAuthError(w, http.StatusInternalServerError, "session could not be created")
		return
	}
	expires := time.Now().Add(a.cfg.Auth.SessionTTL.Duration)
	claims := sessionClaims{UserID: account.ID, CSRF: csrf, Expires: expires.Unix()}
	encoded, err := a.secureCookie.Encode(sessionCookie, claims)
	if err != nil {
		writeAuthError(w, http.StatusInternalServerError, "session could not be created")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: encoded, Path: "/", HttpOnly: true, Secure: a.secure,
		SameSite: http.SameSiteLaxMode, MaxAge: int(a.cfg.Auth.SessionTTL.Duration.Seconds()),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (a *Authenticator) Logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, Secure: a.secure,
		SameSite: http.SameSiteLaxMode, MaxAge: -1,
	})
	http.Redirect(w, r, "/", http.StatusFound)
}

func (a *Authenticator) CheckCSRF(r *http.Request, user User) error {
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return nil
	}
	if !subtleEqual(r.Header.Get("X-CSRF-Token"), user.CSRF) {
		return errors.New("invalid CSRF token")
	}
	return a.checkOrigin(r)
}

func (a *Authenticator) checkOrigin(r *http.Request) error {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return nil
	}
	expected, _ := url.Parse(a.cfg.Server.ExternalURL)
	actual, err := url.Parse(origin)
	if err != nil || !strings.EqualFold(actual.Scheme, expected.Scheme) || !strings.EqualFold(actual.Host, expected.Host) {
		return errors.New("invalid request origin")
	}
	return nil
}

func randomURLSafe(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
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

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func writeAuthError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
