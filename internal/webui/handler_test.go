package webui

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestHandlerServesSPAAndAssets(t *testing.T) {
	api, err := url.Parse("http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(api)

	for _, path := range []string{"/", "/saved/query"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `<div id="root"></div>`) {
			t.Fatalf("SPA response for %s: status=%d body=%s", path, recorder.Code, recorder.Body.String())
		}
		if recorder.Header().Get("Cache-Control") != "no-store" || recorder.Header().Get("Content-Security-Policy") == "" {
			t.Fatalf("SPA security/cache headers for %s: %v", path, recorder.Header())
		}
	}

	assets, err := fs.ReadDir(Files, "dist/assets")
	if err != nil || len(assets) == 0 {
		t.Fatalf("read embedded assets: entries=%d err=%v", len(assets), err)
	}
	path := "/assets/" + assets[0].Name()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	if recorder.Code != http.StatusOK || recorder.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset response: status=%d headers=%v", recorder.Code, recorder.Header())
	}
}

func TestHandlerProxiesApplicationRoutes(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/session" {
			http.Error(w, "unexpected API path", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"proxied":true}`))
	}))
	defer api.Close()
	target, err := url.Parse(api.URL)
	if err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	NewHandler(target).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/session", nil))
	if recorder.Code != http.StatusOK || recorder.Body.String() != `{"proxied":true}` {
		t.Fatalf("proxy response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestHandlerHealthDoesNotDependOnAPI(t *testing.T) {
	api, err := url.Parse("http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	NewHandler(api).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("health status: got %d", recorder.Code)
	}
}
