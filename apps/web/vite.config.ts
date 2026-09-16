import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The host serves `dist/` and the bridge on one port (ADR-005 D2). In development, `vite` proxies the
// bridge WebSocket to a running host so HMR and the live project coexist.
// React renders the chrome; the plan canvases and the three.js viewport stay imperative (ADR-018 D1).
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // `@fpv/x` is matched first and never collides with `@/x`, which starts with a slash
      { find: /^@fpv\/(.*)$/, replacement: fileURLToPath(new URL("../../packages/$1/src", import.meta.url)) },
      { find: /^@\/(.*)$/, replacement: fileURLToPath(new URL("./src/$1", import.meta.url)) },
    ],
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: true },
  server: { port: 5173, proxy: { "/bridge": { target: "ws://127.0.0.1:4310", ws: true } } },
});
