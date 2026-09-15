import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The host serves `dist/` and the bridge on one port (ADR-005 D2). In development, `vite` proxies the
// bridge WebSocket to a running host so HMR and the live project coexist.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: [
      { find: /^@fpv\/(.*)$/, replacement: fileURLToPath(new URL("../../packages/$1/src", import.meta.url)) },
    ],
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: true },
  server: { port: 5173, proxy: { "/bridge": { target: "ws://127.0.0.1:4310", ws: true } } },
});
