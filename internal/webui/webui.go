package webui

import "embed"

// Files contains the production Vite build served by the web gateway.
//
//go:embed dist/*
var Files embed.FS
