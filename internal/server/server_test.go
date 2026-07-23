package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vesta-explorer/vesta/internal/auth"
	"github.com/vesta-explorer/vesta/internal/config"
	"github.com/vesta-explorer/vesta/internal/storage"
	"github.com/vesta-explorer/vesta/internal/victoria"
)

type upstreamCapture struct {
	mu      sync.Mutex
	form    url.Values
	headers http.Header
	calls   int
}

type testRuntime struct {
	handler http.Handler
	cfg     *config.Config
	store   *storage.Store
}

type authenticatedTestClient struct {
	handler http.Handler
	cookie  *http.Cookie
	csrf    string
}

func (client authenticatedTestClient) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	r.AddCookie(client.cookie)
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-CSRF-Token") == "vesta-development-csrf" {
		r.Header.Set("X-CSRF-Token", client.csrf)
	}
	client.handler.ServeHTTP(w, r)
}

func testHandler(t *testing.T, upstreamURL string, limits config.LimitsConfig) http.Handler {
	t.Helper()
	handler, _ := testHandlerWithConfig(t, upstreamURL, limits)
	return handler
}

func testHandlerWithConfig(t *testing.T, upstreamURL string, limits config.LimitsConfig) (http.Handler, *config.Config) {
	t.Helper()
	runtime := newTestRuntime(t, upstreamURL, limits)
	return runtime.client(t, "tester@example.test", "correct-horse-battery"), runtime.cfg
}

func newTestRuntime(t *testing.T, upstreamURL string, limits config.LimitsConfig) *testRuntime {
	t.Helper()
	t.Setenv("TEST_VESTA_SESSION", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	cfg := &config.Config{
		Server: config.ServerConfig{ExternalURL: "http://vesta.example.test"},
		Auth: config.AuthConfig{
			SessionSecretEnv: "TEST_VESTA_SESSION",
			SessionTTL:       config.Duration{Duration: time.Hour},
			Bootstrap: config.BootstrapUserConfig{
				Email: "tester@example.test", Name: "Tester", PasswordEnv: "TEST_VESTA_BOOTSTRAP",
				Team: "Platform", Roles: []string{"reader"},
			},
		},
		Storage: config.StorageConfig{Path: ":memory:", ShareTTL: config.Duration{Duration: time.Hour}},
		Limits:  limits,
		Sources: []config.SourceConfig{{
			ID: "prod", Name: "Production", URL: upstreamURL, Roles: []string{"reader"},
			Tenants:      []config.Tenant{{AccountID: "12", ProjectID: "34", Name: "payments"}},
			HiddenFields: []string{"password*", "authorization"},
		}},
	}
	if cfg.Limits.QueryTimeout.Duration == 0 {
		cfg.Limits.QueryTimeout.Duration = time.Second
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
	store, err := storage.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.EnsureBootstrapAdmin(t.Context(), storage.BootstrapUser{
		Email: "tester@example.test", Name: "Tester", Password: "correct-horse-battery",
		Team: "Platform", Roles: []string{"reader"},
	}); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authenticator := auth.New(cfg, store, logger)
	return &testRuntime{
		handler: New(cfg, authenticator, store, victoria.NewClient(), logger),
		cfg:     cfg,
		store:   store,
	}
}

func (runtime *testRuntime) client(t *testing.T, email, password string) http.Handler {
	t.Helper()
	login := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(
		`{"email":`+strconv.Quote(email)+`,"password":`+strconv.Quote(password)+`}`,
	))
	recorder := httptest.NewRecorder()
	runtime.handler.ServeHTTP(recorder, login)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("login status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	cookies := recorder.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("login cookies = %#v", cookies)
	}
	sessionRequest := httptest.NewRequest(http.MethodGet, "/api/v1/session", nil)
	sessionRequest.AddCookie(cookies[0])
	sessionRecorder := httptest.NewRecorder()
	runtime.handler.ServeHTTP(sessionRecorder, sessionRequest)
	if sessionRecorder.Code != http.StatusOK {
		t.Fatalf("session status = %d, body = %s", sessionRecorder.Code, sessionRecorder.Body.String())
	}
	var session struct {
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.Unmarshal(sessionRecorder.Body.Bytes(), &session); err != nil || session.CSRFToken == "" {
		t.Fatalf("invalid session: %s", sessionRecorder.Body.String())
	}
	return authenticatedTestClient{handler: runtime.handler, cookie: cookies[0], csrf: session.CSRFToken}
}

func queryBody(query string) io.Reader {
	value, _ := json.Marshal(map[string]any{
		"sourceId": "prod",
		"tenant":   map[string]string{"accountId": "12", "projectId": "34"},
		"query":    query,
	})
	return bytes.NewReader(value)
}

func TestQueryForwardsOnlyQuerySemantics(t *testing.T) {
	capture := &upstreamCapture{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		capture.mu.Lock()
		capture.calls++
		capture.form = r.PostForm
		capture.headers = r.Header.Clone()
		capture.mu.Unlock()
		w.Header().Set("VL-Request-Duration-Seconds", "0.004")
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = io.WriteString(w, "{\"_time\":\"2026-07-22T12:00:00Z\",\"_msg\":\"one\",\"password_hash\":\"secret\"}\n{\"_time\":\"2026-07-22T12:00:01Z\",\"_msg\":\"two\"}\n")
	}))
	defer upstream.Close()

	handler := testHandler(t, upstream.URL, config.LimitsConfig{})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h error | limit 2"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	capture.mu.Lock()
	defer capture.mu.Unlock()
	if capture.calls != 1 {
		t.Fatalf("upstream calls = %d", capture.calls)
	}
	if got := capture.form.Get("query"); got != "_time:1h error | limit 2" {
		t.Fatalf("query = %q", got)
	}
	for _, forbidden := range []string{"start", "end", "limit", "offset", "extra_filters"} {
		if capture.form.Has(forbidden) {
			t.Fatalf("unexpected upstream parameter %q", forbidden)
		}
	}
	if len(capture.form) != 2 || capture.form.Get("hidden_fields_filters") != `["password*","authorization"]` {
		t.Fatalf("normal query form contains unexpected semantics: %v", capture.form)
	}
	if capture.headers.Get("AccountID") != "12" || capture.headers.Get("ProjectID") != "34" {
		t.Fatal("tenant headers were not forwarded")
	}

	var events []streamEvent
	scanner := bufio.NewScanner(strings.NewReader(recorder.Body.String()))
	for scanner.Scan() {
		var event streamEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	if len(events) != 4 || events[0].Type != "meta" || events[1].Type != "row" || events[3].Status != "complete" {
		t.Fatalf("unexpected events: %#v", events)
	}
	if _, leaked := events[1].Row["password_hash"]; leaked {
		t.Fatal("hidden field reached the browser")
	}
}

func TestMalformedAndPartialUpstreamRows(t *testing.T) {
	t.Run("partial line is assembled", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, "{\"_time\":\"1\",")
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			_, _ = io.WriteString(w, "\"_msg\":\"complete\"}\n")
		}))
		defer upstream.Close()
		handler := testHandler(t, upstream.URL, config.LimitsConfig{})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h"))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if !strings.Contains(recorder.Body.String(), `"_msg":"complete"`) || !strings.Contains(recorder.Body.String(), `"status":"complete"`) {
			t.Fatalf("partial row was not streamed correctly: %s", recorder.Body.String())
		}
	})

	t.Run("malformed row becomes terminal error", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, "{not-json}\n")
		}))
		defer upstream.Close()
		handler := testHandler(t, upstream.URL, config.LimitsConfig{})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h"))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if !strings.Contains(recorder.Body.String(), `"status":"error"`) || !strings.Contains(recorder.Body.String(), "malformed JSON row") {
			t.Fatalf("malformed row was not reported: %s", recorder.Body.String())
		}
	})
}

func TestTimeoutAndClientCancellationStopUpstream(t *testing.T) {
	t.Run("execution timeout is visible", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		}))
		defer upstream.Close()
		handler := testHandler(t, upstream.URL, config.LimitsConfig{QueryTimeout: config.Duration{Duration: 25 * time.Millisecond}})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h"))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if !strings.Contains(recorder.Body.String(), `"status":"truncated"`) || !strings.Contains(recorder.Body.String(), "execution timeout") {
			t.Fatalf("timeout was not visible: %s", recorder.Body.String())
		}
	})

	t.Run("client cancellation reaches upstream", func(t *testing.T) {
		started := make(chan struct{})
		cancelled := make(chan struct{})
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			close(started)
			<-r.Context().Done()
			close(cancelled)
		}))
		defer upstream.Close()
		handler := testHandler(t, upstream.URL, config.LimitsConfig{QueryTimeout: config.Duration{Duration: time.Second}})
		ctx, cancel := context.WithCancel(context.Background())
		req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h")).WithContext(ctx)
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		done := make(chan struct{})
		go func() {
			handler.ServeHTTP(recorder, req)
			close(done)
		}()
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("upstream request did not start")
		}
		cancel()
		select {
		case <-cancelled:
		case <-time.After(time.Second):
			t.Fatal("upstream request was not cancelled promptly")
		}
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("Vesta request did not stop after cancellation")
		}
	})
}

func TestUpstreamErrorsAndHiddenFieldMetadata(t *testing.T) {
	t.Run("upstream error is normalized", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "bad LogsQL", http.StatusUnprocessableEntity)
		}))
		defer upstream.Close()
		handler := testHandler(t, upstream.URL, config.LimitsConfig{})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h"))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusBadGateway || !strings.Contains(recorder.Body.String(), "bad LogsQL") {
			t.Fatalf("upstream error not propagated safely: status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("hidden metadata is inaccessible", func(t *testing.T) {
		calls := 0
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			calls++
			_, _ = io.WriteString(w, `{"values":[{"value":"host","hits":4},{"value":"password_hash","hits":2}]}`)
		}))
		defer upstream.Close()
		handler := testHandler(t, upstream.URL, config.LimitsConfig{})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/fields", queryBody("_time:1h"))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusOK || strings.Contains(recorder.Body.String(), "password_hash") || !strings.Contains(recorder.Body.String(), "host") {
			t.Fatalf("field policy was not applied: status=%d body=%s", recorder.Code, recorder.Body.String())
		}

		valueBody, _ := json.Marshal(map[string]any{
			"sourceId": "prod", "tenant": map[string]string{"accountId": "12", "projectId": "34"},
			"query": "_time:1h", "field": "password_hash",
		})
		req = httptest.NewRequest(http.MethodPost, "/api/v1/field-values", bytes.NewReader(valueBody))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder = httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusForbidden || calls != 1 {
			t.Fatalf("hidden field values reached upstream: status=%d calls=%d", recorder.Code, calls)
		}
	})
}

func TestQueryRequiresActualTimeFilter(t *testing.T) {
	called := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer upstream.Close()
	handler := testHandler(t, upstream.URL, config.LimitsConfig{})
	for _, query := range []string{"error | fields _time", "error # _time:1h", `"_time:1h"`} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody(query))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusUnprocessableEntity {
			t.Fatalf("query %q status = %d", query, recorder.Code)
		}
	}
	if called {
		t.Fatal("invalid query reached VictoriaLogs")
	}
}

func TestQueryEmitsVisibleTruncation(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "{\"_time\":\"1\",\"_msg\":\"one\"}\n{\"_time\":\"2\",\"_msg\":\"two\"}\n")
	}))
	defer upstream.Close()
	handler := testHandler(t, upstream.URL, config.LimitsConfig{MaxRows: 1})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/query", queryBody("_time:1h"))
	req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if !strings.Contains(recorder.Body.String(), `"status":"truncated"`) || !strings.Contains(recorder.Body.String(), "viewer safety limit") {
		t.Fatalf("truncation was not visible: %s", recorder.Body.String())
	}
}

func TestSessionReturnsOnlyAuthorizedContexts(t *testing.T) {
	upstream := httptest.NewServer(http.NotFoundHandler())
	defer upstream.Close()
	handler := testHandler(t, upstream.URL, config.LimitsConfig{})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/session", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), upstream.URL) {
		t.Fatal("VictoriaLogs URL leaked to the browser")
	}
	if !strings.Contains(recorder.Body.String(), `"id":"prod"`) || !strings.Contains(recorder.Body.String(), `"accountId":"12"`) {
		t.Fatalf("missing authorized source: %s", recorder.Body.String())
	}
}

func TestPrivateSharesRequireLoginAndEnforceUserOrTeamAudience(t *testing.T) {
	upstream := httptest.NewServer(http.NotFoundHandler())
	defer upstream.Close()
	runtime := newTestRuntime(t, upstream.URL, config.LimitsConfig{})
	creator := runtime.client(t, "tester@example.test", "correct-horse-battery")
	tester, err := runtime.store.Authenticate(t.Context(), "tester@example.test", "correct-horse-battery")
	if err != nil {
		t.Fatal(err)
	}
	teamID := tester.Teams[0].ID

	createUser := func(email, password string, roles []string, joinTeam bool) http.Handler {
		account, err := runtime.store.CreateUser(t.Context(), storage.CreateUserInput{
			Email: email, Name: email, Password: password, Roles: roles,
		})
		if err != nil {
			t.Fatal(err)
		}
		if joinTeam {
			if err := runtime.store.AddTeamMember(t.Context(), teamID, account.ID); err != nil {
				t.Fatal(err)
			}
		}
		return runtime.client(t, email, password)
	}
	alice := createUser("alice@example.test", "alice-secure-password", []string{"reader"}, false)
	restricted := createUser("restricted@example.test", "restricted-password", []string{"other-role"}, false)
	teammate := createUser("teammate@example.test", "teammate-password", []string{"reader"}, true)
	outsider := createUser("outsider@example.test", "outsider-password", []string{"reader"}, false)

	makeShare := func(client http.Handler, audience map[string]string) string {
		t.Helper()
		body, err := json.Marshal(map[string]any{
			"payload": map[string]any{
				"query": "_time:1h error", "sourceId": "prod",
				"tenant": map[string]string{"accountId": "12", "projectId": "34", "name": "payments"},
				"title":  "Errors", "resultMode": "table",
			},
			"audience": audience,
		})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/shares", bytes.NewReader(body))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		client.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusCreated {
			t.Fatalf("create share status = %d, body = %s", recorder.Code, recorder.Body.String())
		}
		var response struct {
			Token string `json:"token"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil || response.Token == "" {
			t.Fatalf("invalid create response: %s", recorder.Body.String())
		}
		return response.Token
	}

	openShare := func(client http.Handler, token string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"token": token})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/shares/open", bytes.NewReader(body))
		req.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		client.ServeHTTP(recorder, req)
		return recorder
	}

	userToken := makeShare(creator, map[string]string{"type": "user", "value": "alice@example.test"})
	if recorder := openShare(creator, userToken); recorder.Code != http.StatusForbidden {
		t.Fatalf("wrong user opened share: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := openShare(alice, userToken); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"_time:1h error"`) {
		t.Fatalf("addressed user could not open share: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	restrictedToken := makeShare(creator, map[string]string{"type": "user", "value": "restricted@example.test"})
	if recorder := openShare(restricted, restrictedToken); recorder.Code != http.StatusForbidden {
		t.Fatalf("recipient without log access opened share: status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	teamToken := makeShare(creator, map[string]string{"type": "team", "value": teamID})
	if recorder := openShare(teammate, teamToken); recorder.Code != http.StatusOK {
		t.Fatalf("teammate could not open share: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := openShare(outsider, teamToken); recorder.Code != http.StatusForbidden {
		t.Fatalf("non-member opened team share: status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	request := httptest.NewRequest(http.MethodPost, "/api/v1/shares/open", strings.NewReader(`{"token":"anything"}`))
	recorder := httptest.NewRecorder()
	runtime.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous share open status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestPrivateShareRejectsTeamOutsideCreatorMembership(t *testing.T) {
	upstream := httptest.NewServer(http.NotFoundHandler())
	defer upstream.Close()
	runtime := newTestRuntime(t, upstream.URL, config.LimitsConfig{})
	handler := runtime.client(t, "tester@example.test", "correct-horse-battery")
	otherTeam, err := runtime.store.CreateTeam(t.Context(), "Other team")
	if err != nil {
		t.Fatal(err)
	}
	body := `{"payload":{"query":"_time:1h","sourceId":"prod","tenant":{"accountId":"12","projectId":"34"},"title":"Errors","resultMode":"table"},"audience":{"type":"team","value":"` + otherTeam.ID + `"}}`
	request := httptest.NewRequest(http.MethodPost, "/api/v1/shares", strings.NewReader(body))
	request.Header.Set("X-CSRF-Token", "vesta-development-csrf")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestLocalDirectoryAndFolderedTeamQueries(t *testing.T) {
	upstream := httptest.NewServer(http.NotFoundHandler())
	defer upstream.Close()
	runtime := newTestRuntime(t, upstream.URL, config.LimitsConfig{})
	admin := runtime.client(t, "tester@example.test", "correct-horse-battery")

	post := func(client http.Handler, path, body string, want int) []byte {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		request.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		recorder := httptest.NewRecorder()
		client.ServeHTTP(recorder, request)
		if recorder.Code != want {
			t.Fatalf("%s status = %d, body = %s", path, recorder.Code, recorder.Body.String())
		}
		return recorder.Body.Bytes()
	}
	var member storage.User
	if err := json.Unmarshal(post(admin, "/api/v1/admin/users", `{
		"email":"member@example.test","name":"Member","password":"member-secure-password",
		"roles":["reader"],"isAdmin":false
	}`, http.StatusCreated), &member); err != nil {
		t.Fatal(err)
	}
	var team storage.Team
	if err := json.Unmarshal(post(admin, "/api/v1/admin/teams", `{"name":"On call"}`, http.StatusCreated), &team); err != nil {
		t.Fatal(err)
	}
	post(admin, "/api/v1/admin/memberships", `{"userId":"`+member.ID+`","teamId":"`+team.ID+`"}`, http.StatusNoContent)

	memberClient := runtime.client(t, "member@example.test", "member-secure-password")
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/directory", nil)
	recorder := httptest.NewRecorder()
	memberClient.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("non-admin directory status = %d", recorder.Code)
	}

	var folder storage.Folder
	if err := json.Unmarshal(post(memberClient, "/api/v1/team-folders", `{"teamId":"`+team.ID+`","name":"Incidents"}`, http.StatusCreated), &folder); err != nil {
		t.Fatal(err)
	}
	post(memberClient, "/api/v1/team-queries", `{
		"teamId":"`+team.ID+`","folderId":"`+folder.ID+`",
		"payload":{"query":"_time:1h error","sourceId":"prod",
		"tenant":{"accountId":"12","projectId":"34","name":"payments"},
		"title":"","resultMode":"table"}
	}`, http.StatusBadRequest)

	var item storage.TeamQuery
	if err := json.Unmarshal(post(memberClient, "/api/v1/team-queries", `{
		"teamId":"`+team.ID+`","folderId":"`+folder.ID+`",
		"payload":{"query":"_time:1h error","sourceId":"prod",
		"tenant":{"accountId":"12","projectId":"34","name":"payments"},
		"title":"Recent errors","resultMode":"table"}
	}`, http.StatusCreated), &item); err != nil {
		t.Fatal(err)
	}

	var archive storage.Folder
	if err := json.Unmarshal(post(memberClient, "/api/v1/team-folders", `{"teamId":"`+team.ID+`","name":"Archive"}`, http.StatusCreated), &archive); err != nil {
		t.Fatal(err)
	}
	var updated storage.TeamQuery
	if err := json.Unmarshal(post(memberClient, "/api/v1/team-queries/"+item.ID, `{
		"title":"Priority errors","folderId":"`+archive.ID+`"
	}`, http.StatusOK), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Title != "Priority errors" || updated.FolderID != archive.ID {
		t.Fatalf("unexpected updated team star: %#v", updated)
	}
	post(memberClient, "/api/v1/team-queries/"+item.ID, `{"title":" ","folderId":""}`, http.StatusBadRequest)

	request = httptest.NewRequest(http.MethodGet, "/api/v1/team-library", nil)
	recorder = httptest.NewRecorder()
	memberClient.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"name":"Archive"`) ||
		!strings.Contains(recorder.Body.String(), `"title":"Priority errors"`) {
		t.Fatalf("unexpected team library: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestAdminAccessManagement(t *testing.T) {
	runtime := newTestRuntime(t, "http://upstream-secret.example.test", config.LimitsConfig{})
	runtime.cfg.Sources[0].Tenants[0].Roles = []string{"tenant-reader"}
	runtime.cfg.Sources[0].Tenants = append(runtime.cfg.Sources[0].Tenants, config.Tenant{
		AccountID: "56", ProjectID: "78", Name: "shared",
	})
	admin := runtime.client(t, "tester@example.test", "correct-horse-battery")

	do := func(client http.Handler, method, path, body string, want int) []byte {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		if method != http.MethodGet {
			request.Header.Set("X-CSRF-Token", "vesta-development-csrf")
		}
		recorder := httptest.NewRecorder()
		client.ServeHTTP(recorder, request)
		if recorder.Code != want {
			t.Fatalf("%s %s status = %d, body = %s", method, path, recorder.Code, recorder.Body.String())
		}
		return recorder.Body.Bytes()
	}

	permissionsBody := do(admin, http.MethodGet, "/api/v1/admin/permissions", "", http.StatusOK)
	var catalog permissionCatalog
	if err := json.Unmarshal(permissionsBody, &catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.Roles) != 2 || catalog.Roles[0] != "reader" || catalog.Roles[1] != "tenant-reader" ||
		len(catalog.Sources) != 1 || len(catalog.Sources[0].Tenants) != 2 ||
		catalog.Sources[0].Tenants[1].Roles == nil {
		t.Fatalf("unexpected permission catalog: %#v", catalog)
	}
	permissionsJSON := string(permissionsBody)
	if strings.Contains(permissionsJSON, "upstream-secret") || strings.Contains(permissionsJSON, "hiddenFields") ||
		strings.Contains(permissionsJSON, "authorization") || strings.Contains(permissionsJSON, `"roles":null`) {
		t.Fatalf("permission catalog exposed sensitive source configuration: %s", permissionsJSON)
	}

	do(admin, http.MethodPost, "/api/v1/admin/users", `{
		"email":"unknown@example.test","name":"Unknown","password":"member-secure-password",
		"roles":["future-role"],"isAdmin":false
	}`, http.StatusBadRequest)

	var member storage.User
	if err := json.Unmarshal(do(admin, http.MethodPost, "/api/v1/admin/users", `{
		"email":"member@example.test","name":"Member","password":"member-secure-password",
		"roles":["reader"],"isAdmin":false
	}`, http.StatusCreated), &member); err != nil {
		t.Fatal(err)
	}
	memberClient := runtime.client(t, "member@example.test", "member-secure-password")
	do(memberClient, http.MethodGet, "/api/v1/admin/permissions", "", http.StatusForbidden)

	adminUser, err := runtime.store.FindUser(t.Context(), "tester@example.test")
	if err != nil {
		t.Fatal(err)
	}
	platformID := adminUser.Teams[0].ID
	var updated storage.User
	updateBody := `{
		"email":"renamed@example.test","name":"Renamed member","roles":["reader","tenant-reader"],
		"isAdmin":false,"disabled":false,"teamIds":["` + platformID + `"]
	}`
	if err := json.Unmarshal(do(admin, http.MethodPut, "/api/v1/admin/users/"+member.ID, updateBody, http.StatusOK), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Email != "renamed@example.test" || len(updated.Teams) != 1 || len(updated.Roles) != 2 {
		t.Fatalf("unexpected updated user: %#v", updated)
	}

	legacy, err := runtime.store.CreateUser(t.Context(), storage.CreateUserInput{
		Email: "legacy@example.test", Name: "Legacy", Password: "legacy-secure-password",
		Roles: []string{"legacy-role"},
	})
	if err != nil {
		t.Fatal(err)
	}
	do(admin, http.MethodPut, "/api/v1/admin/users/"+legacy.ID, `{
		"email":"legacy@example.test","name":"Legacy","roles":["legacy-role","reader"],
		"isAdmin":false,"disabled":false,"teamIds":[]
	}`, http.StatusOK)
	do(admin, http.MethodPut, "/api/v1/admin/users/"+legacy.ID, `{
		"email":"legacy@example.test","name":"Legacy","roles":["legacy-role","new-role"],
		"isAdmin":false,"disabled":false,"teamIds":[]
	}`, http.StatusBadRequest)

	do(admin, http.MethodPut, "/api/v1/admin/users/"+adminUser.ID, `{
		"email":"tester@example.test","name":"Tester","roles":["reader"],
		"isAdmin":false,"disabled":false,"teamIds":["`+platformID+`"]
	}`, http.StatusConflict)

	teamJSON := do(admin, http.MethodPost, "/api/v1/admin/teams", `{"name":"On call"}`, http.StatusCreated)
	var team storage.Team
	if err := json.Unmarshal(teamJSON, &team); err != nil {
		t.Fatal(err)
	}
	do(admin, http.MethodPut, "/api/v1/admin/teams/"+team.ID, `{"name":"Incident response"}`, http.StatusOK)
	do(admin, http.MethodPut, "/api/v1/admin/teams/"+team.ID, `{"name":"Platform"}`, http.StatusConflict)

	do(admin, http.MethodPut, "/api/v1/admin/users/"+member.ID, `{
		"email":"renamed@example.test","name":"Renamed member","roles":["reader"],
		"isAdmin":false,"disabled":true,"teamIds":[]
	}`, http.StatusOK)
	do(memberClient, http.MethodGet, "/api/v1/session", "", http.StatusUnauthorized)
}
