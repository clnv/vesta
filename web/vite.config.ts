import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../internal/webui/dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/@codemirror/") || id.includes("/node_modules/@uiw/") || id.includes("/node_modules/codemirror/")) return "editor";
          if (id.includes("/node_modules/react") || id.includes("/node_modules/scheduler/")) return "react";
          if (id.includes("/node_modules/lucide-react/")) return "icons";
          if (id.includes("/node_modules/fflate/") || id.includes("/node_modules/idb-keyval/") || id.includes("/node_modules/@tanstack/")) return "workspace";
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/auth": "http://127.0.0.1:8080",
      "/metrics": "http://127.0.0.1:8080",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
