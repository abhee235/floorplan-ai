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
      // the chrome imports its shadcn components through "@/", the same alias tsconfig and vite carry
      { find: /^@\/(.*)$/, replacement: fileURLToPath(new URL("./apps/web/src/$1", import.meta.url)) },
    ],
  },
  test: {
    // .tsx is collected too, for the React chrome (ADR-018 D5)
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts?(x)", "tools/test/**/*.test.ts"],
    // Node stays the default: almost every test here is a rule, not a component, and running the whole
    // suite in a DOM would be slower for no gain. The few chrome tests ask for jsdom per file, with a
    // `@vitest-environment jsdom` docblock.
    environment: "node",
  },
});
