package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/vesta-explorer/vesta/internal/webui"
)

func main() {
	listen := flag.String("listen", ":8081", "web listen address")
	apiAddress := flag.String("api-url", "http://127.0.0.1:8080", "API base URL")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	api, err := url.Parse(*apiAddress)
	if err != nil || api.Host == "" || api.Scheme != "http" && api.Scheme != "https" {
		logger.Error("invalid API URL")
		os.Exit(1)
	}

	httpServer := &http.Server{
		Addr:              *listen,
		Handler:           webui.NewHandler(api),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	shutdownCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-shutdownCtx.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(ctx); err != nil {
			logger.Error("graceful shutdown", "error", err)
		}
	}()

	logger.Info("Vesta web listening", "address", *listen, "api", api.Redacted())
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("serve", "error", err)
		os.Exit(1)
	}
}
