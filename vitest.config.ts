import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@fpv/catalog/store",
        replacement: fileURLToPath(new URL("./packages/catalog/src/node.ts", import.meta.url)),
      },
      { find: /^@fpv\/(.*)$/, replacement: fileURLToPath(new URL("./packages/$1/src", import.meta.url)) },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "tools/test/**/*.test.ts"],
    environment: "node",
  },
});
