package webui

import "embed"

// Files contains the production Vite build so the Go binary can serve the UI
// without a second runtime or sidecar.
//
//go:embed dist/*
var Files embed.FS
