package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/vesta-explorer/vesta/internal/auth"
	"github.com/vesta-explorer/vesta/internal/config"
	"github.com/vesta-explorer/vesta/internal/server"
	"github.com/vesta-explorer/vesta/internal/storage"
	"github.com/vesta-explorer/vesta/internal/victoria"
)

func main() {
	configPath := flag.String("config", "config.yml", "path to the Vesta configuration file")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := config.Load(*configPath)
	if err != nil {
		logger.Error("load configuration", "error", err)
		os.Exit(1)
	}

	store, err := storage.Open(cfg.Storage.Path)
	if err != nil {
		logger.Error("initialize storage", "error", err)
		os.Exit(1)
	}
	defer func() {
		if err := store.Close(); err != nil {
			logger.Error("close storage", "error", err)
		}
	}()
	if err := store.EnsureBootstrapAdmin(context.Background(), storage.BootstrapUser{
		Email:    cfg.Auth.Bootstrap.Email,
		Name:     cfg.Auth.Bootstrap.Name,
		Password: cfg.BootstrapPassword(),
		Team:     cfg.Auth.Bootstrap.Team,
		Roles:    cfg.Auth.Bootstrap.Roles,
	}); err != nil {
		logger.Error("initialize bootstrap administrator", "error", err)
		os.Exit(1)
	}

	authenticator := auth.New(cfg, store, logger)
	handler := server.New(cfg, authenticator, store, victoria.NewClient(), logger)
	httpServer := &http.Server{
		Addr:              cfg.Server.Listen,
		Handler:           handler,
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

	logger.Info("Vesta API listening", "address", cfg.Server.Listen, "sources", len(cfg.Sources))
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("serve", "error", err)
		os.Exit(1)
	}
}
