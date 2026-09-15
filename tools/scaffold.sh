#!/usr/bin/env bash
# Phase 0 scaffold generator (ADR-002). Idempotent: never overwrites an existing src/index.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p packages apps tools/ledger tools/fixtures docs/eval

cat > package.json <<'EOF'
{
  "name": "floorplan-viz",
  "private": true,
  "version": "0.0.1",
  "description": "Floor plans and briefs to editable 3D office models and a bill of materials",
  "type": "module",
  "packageManager": "pnpm@10.15.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "lint": "biome check . && tsx tools/check-boundaries.ts",
    "format": "biome format --write .",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "ledger:coverage": "tsx tools/ledger-coverage.ts",
    "check": "pnpm lint && pnpm typecheck && pnpm test && pnpm ledger:coverage"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.2.0",
    "@types/node": "^22.10.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
EOF

cat > pnpm-workspace.yaml <<'EOF'
packages:
  - "packages/*"
  - "apps/*"
EOF

cat > .npmrc <<'EOF'
auto-install-peers=true
strict-peer-dependencies=false
EOF

echo "22" > .node-version

cat > tsconfig.base.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "useUnknownInCatchVariables": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["node"]
  }
}
EOF

cat > tsconfig.json <<'EOF'
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "@fpv/*": ["packages/*/src"] }
  },
  "include": ["packages/*/src", "packages/*/test", "apps/*/src", "apps/*/test", "tools/*.ts", "tools/test"]
}
EOF

cat > vitest.config.ts <<'EOF'
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [{ find: /^@fpv\/(.*)$/, replacement: fileURLToPath(new URL("./packages/$1/src", import.meta.url)) }],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "tools/test/**/*.test.ts"],
    environment: "node",
  },
});
EOF

cat > biome.json <<'EOF'
{
  "$schema": "https://biomejs.dev/schemas/2.2.0/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/node_modules", "!**/dist", "!**/*.fpviz/**", "!docs/**"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 110 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } }
}
EOF

cat > .gitignore <<'EOF'
node_modules/
dist/
coverage/
*.tsbuildinfo
.DS_Store
docs/eval/*.json
**/.fpviz/session.json
**/recovery.json
EOF

cat > .gitattributes <<'EOF'
* text=auto eol=lf
*.png binary
*.glb binary
*.ktx2 binary
EOF

cat > README.md <<'EOF'
# Floorplan-Viz

Floor plans and briefs become editable 3D office models and a traceable bill of materials.

- Documentation and decisions: `docs/` (start at `docs/README.md`).
- Layout and rules: `docs/adr/ADR-002-typescript-monorepo.md`.
- Commands: `pnpm install`, `pnpm check` (lint, boundaries, typecheck, tests, ledger coverage).

Run pnpm through corepack if it is not installed: `corepack pnpm install`.
EOF

mk() {
  local name="$1" desc="$2" deps="$3"
  local dir="packages/$name"
  mkdir -p "$dir/src" "$dir/test"
  cat > "$dir/package.json" <<EOF
{
  "name": "@fpv/$name",
  "version": "0.0.1",
  "private": true,
  "description": "$desc",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {$deps}
}
EOF
  printf '{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }\n' > "$dir/tsconfig.json"
  if [ ! -f "$dir/src/index.ts" ]; then
    printf '// @fpv/%s: %s\nexport const PACKAGE = "%s" as const;\n' "$name" "$desc" "$name" > "$dir/src/index.ts"
  fi
  if [ ! -f "$dir/test/smoke.test.ts" ]; then
    cat > "$dir/test/smoke.test.ts" <<EOF
import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/$name", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("$name");
  });
});
EOF
  fi
}

mk ir        "Scene IR: schema, validation, normalisation, derived values, serialisation (spec 01)" ' "zod": "^3.25.0" '
mk geometry  "2D kernel: footprints, joins, arcs, booleans, detection (spec 05)" ' "@fpv/ir": "workspace:*", "polygon-clipping": "^0.15.7" '
mk catalog   "Products, textures, libraries, verification, BOM rules (spec 02, 07)" ' "@fpv/ir": "workspace:*", "zod": "^3.25.0" '
mk commands  "Commands as data, reducers, transactions, history (spec 03)" ' "@fpv/ir": "workspace:*", "@fpv/geometry": "workspace:*", "@fpv/catalog": "workspace:*", "immer": "^10.1.0" '
mk assets    "Primitive recipes, glTF manifest, licence manifest (spec 02)" ' "@fpv/ir": "workspace:*" '
mk engine    "IR to geometry buffers, invalidation table (spec 05)" ' "@fpv/ir": "workspace:*", "@fpv/geometry": "workspace:*", "@fpv/commands": "workspace:*", "@fpv/catalog": "workspace:*", "@fpv/assets": "workspace:*" '
mk exporters "CSV, XLSX, GLB, DXF, PDF exports (ADR-013)" ' "@fpv/ir": "workspace:*", "@fpv/engine": "workspace:*", "@fpv/catalog": "workspace:*" '
mk importers "DXF, PDF, raster clean-up to PlanDraft (spec 06)" ' "@fpv/ir": "workspace:*", "@fpv/geometry": "workspace:*" '
mk tools     "The tool registry: schemas, descriptions, functions (spec 04)" ' "@fpv/ir": "workspace:*", "@fpv/commands": "workspace:*", "@fpv/engine": "workspace:*", "@fpv/catalog": "workspace:*", "@fpv/geometry": "workspace:*", "@fpv/assets": "workspace:*", "@fpv/exporters": "workspace:*", "@fpv/importers": "workspace:*" '
mk agents    "Provider interface, agent runner, roles, prompts (ADR-007)" ' "@fpv/ir": "workspace:*", "@fpv/catalog": "workspace:*", "@fpv/tools": "workspace:*", "@fpv/importers": "workspace:*" '

app() {
  local name="$1" desc="$2" deps="$3"
  local dir="apps/$name"
  mkdir -p "$dir/src" "$dir/test"
  cat > "$dir/package.json" <<EOF
{
  "name": "@fpv/$name",
  "version": "0.0.1",
  "private": true,
  "description": "$desc",
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {$deps}
}
EOF
  printf '{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }\n' > "$dir/tsconfig.json"
  if [ ! -f "$dir/src/index.ts" ]; then
    printf '// @fpv/%s: %s\nexport const PACKAGE = "%s" as const;\n' "$name" "$desc" "$name" > "$dir/src/index.ts"
  fi
  if [ ! -f "$dir/test/smoke.test.ts" ]; then
    cat > "$dir/test/smoke.test.ts" <<EOF
import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/$name", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("$name");
  });
});
EOF
  fi
}

app host "Session host: project state, file system, catalog db, agent runner, viewer bridge, optional MCP adapter (ADR-005). Phase 0 placeholder." ' "@fpv/ir": "workspace:*", "@fpv/commands": "workspace:*", "@fpv/engine": "workspace:*", "@fpv/catalog": "workspace:*", "@fpv/tools": "workspace:*", "@fpv/agents": "workspace:*", "@fpv/exporters": "workspace:*", "@fpv/importers": "workspace:*", "@fpv/assets": "workspace:*" '
app web  "Replica web app: plan canvas, three.js viewer, editor chrome (ADR-003, ADR-005). Phase 0 placeholder." ' "@fpv/ir": "workspace:*", "@fpv/engine": "workspace:*", "@fpv/commands": "workspace:*", "@fpv/geometry": "workspace:*", "@fpv/assets": "workspace:*" '

echo "scaffold written"
