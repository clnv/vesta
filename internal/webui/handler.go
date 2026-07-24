package webui

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"io/fs"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

const cspNoncePlaceholder = "__VESTA_CSP_NONCE__"

// NewHandler serves the embedded SPA and proxies same-origin application
// routes to the API.
func NewHandler(api *url.URL) http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(api)
			request.SetXForwarded()
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "API is unavailable", http.StatusBadGateway)
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.Handle("/api/", proxy)
	mux.Handle("/auth/", proxy)
	mux.Handle("/metrics", proxy)
	mux.Handle("/", staticHandler())
	return securityHeaders(mux)
}

func staticHandler() http.Handler {
	dist, err := fs.Sub(Files, "dist")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path != "" {
			if _, err := fs.Stat(dist, path); err == nil {
				if strings.HasPrefix(path, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		index, err := fs.ReadFile(dist, "index.html")
		if err != nil {
			http.Error(w, "web build is unavailable", http.StatusServiceUnavailable)
			return
		}
		nonce, err := newCSPNonce()
		if err != nil {
			http.Error(w, "web security initialization failed", http.StatusInternalServerError)
			return
		}
		index = bytes.ReplaceAll(index, []byte(cspNoncePlaceholder), []byte(nonce))
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy(nonce))
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(index)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy(""))
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func newCSPNonce() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(value), nil
}

func contentSecurityPolicy(nonce string) string {
	styleSource := "style-src 'self'"
	if nonce != "" {
		styleSource += " 'nonce-" + nonce + "'"
	}
	return "default-src 'self'; connect-src 'self'; img-src 'self' data:; " + styleSource + "; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
}
