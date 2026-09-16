// Package boundary checker (ADR-002 D2). Fails when a package imports a workspace package it may not depend on.
// Usage: tsx tools/check-boundaries.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Allowed workspace imports per package. Keys and values are package names without the @fpv/ prefix. */
const ALLOWED: Record<string, readonly string[]> = {
  ir: [],
  geometry: ["ir"],
  catalog: ["ir", "assets"],
  assets: ["ir"],
  commands: ["ir", "geometry", "catalog"],
  engine: ["ir", "geometry", "commands", "catalog", "assets"],
  exporters: ["ir", "engine", "catalog"],
  importers: ["ir", "geometry"],
  tools: ["ir", "commands", "engine", "catalog", "geometry", "assets", "exporters", "importers"],
  agents: ["ir", "catalog", "tools", "importers"],
  host: [
    "ir",
    "commands",
    "engine",
    "catalog",
    "geometry",
    "assets",
    "tools",
    "agents",
    "exporters",
    "importers",
  ],
  web: ["ir", "engine", "commands", "geometry", "assets", "importers", "catalog"],
};

/** Packages that must never import the DOM or three.js so they stay runnable in Node. */
const NODE_ONLY = new Set(["ir", "geometry", "engine", "commands", "catalog"]);
const FORBIDDEN_IN_NODE_ONLY = [/^three(\/|$)/, /^react(\/|$)/, /^vite(\/|$)/];

/**
 * Those same packages also stay free of Node-only APIs so they run in the browser, except the files
 * behind the `@fpv/catalog/store` subpath entry (ADR-002): the SQLite store and on-disk installation.
 */
const NODE_API_FILES = new Set([
  "packages/catalog/src/store.ts",
  "packages/catalog/src/install.ts",
  "packages/catalog/src/fetcher.ts",
  "packages/catalog/src/node.ts",
]);
/** Only the host may import the Node-only catalog entry. */
const NODE_SUBPATH = "@fpv/catalog/store";
const NODE_SUBPATH_ALLOWED = new Set(["host", "catalog"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "dist") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

function packageDirs(): { name: string; dir: string }[] {
  const result: { name: string; dir: string }[] = [];
  for (const group of ["packages", "apps"]) {
    const base = join(ROOT, group);
    let names: string[] = [];
    try {
      names = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(base, name, "src");
      try {
        if (statSync(dir).isDirectory()) result.push({ name, dir });
      } catch {
        // no src yet
      }
    }
  }
  return result;
}

const importRe =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

let violations = 0;
for (const { name, dir } of packageDirs()) {
  const allowed = ALLOWED[name];
  if (!allowed) {
    console.error(`no boundary rule for package "${name}"; add it to tools/check-boundaries.ts`);
    violations += 1;
    continue;
  }
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importRe)) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      const rel = relative(ROOT, file);
      const workspace = /^@fpv\/([a-z-]+)/.exec(spec)?.[1];
      if (workspace && workspace !== name && !allowed.includes(workspace)) {
        console.error(
          `${rel}: "${name}" may not import "@fpv/${workspace}" (allowed: ${allowed.join(", ") || "none"})`,
        );
        violations += 1;
      }
      if (NODE_ONLY.has(name) && FORBIDDEN_IN_NODE_ONLY.some((re) => re.test(spec))) {
        console.error(`${rel}: "${name}" must stay Node-only and may not import "${spec}"`);
        violations += 1;
      }
      const posix = rel.replaceAll("\\", "/");
      if (NODE_ONLY.has(name) && /^node:/.test(spec) && !NODE_API_FILES.has(posix)) {
        console.error(`${rel}: "${name}" runs in the browser and may not import "${spec}"`);
        violations += 1;
      }
      if (spec === NODE_SUBPATH && !NODE_SUBPATH_ALLOWED.has(name)) {
        console.error(`${rel}: only the host may import "${NODE_SUBPATH}"`);
        violations += 1;
      }
    }
  }
}

if (violations > 0) {
  console.error(`boundaries: ${violations} violation(s)`);
  process.exit(1);
}
console.log("boundaries: ok");
