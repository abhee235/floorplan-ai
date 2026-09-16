// Ledger coverage report (ADR-002 D4, spec 08).
// Reads every id from the edge-case ledger, the disposition map in tools/ledger/dispositions.json, and scans
// test files for ledger ids in their text.
//
// The ledger is private and never lives in this repository. It is read from FPV_LEDGER_FILE, or from
// ../floorplan-ai-private/02-edge-case-ledger.md beside the checkout; without it the report is skipped, so a
// public clone still passes `pnpm check`. The dispositions and the ids in test names stay here. Prints per-package coverage and writes
// docs/eval/ledger-coverage.json. Exits 1 only in strict mode (tools/ledger/current-phase.json "gate": true
// or --strict) when an adopt/reverse/reject id due in the current phase or earlier has no test.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LEDGER = process.env.FPV_LEDGER_FILE
  ? resolve(process.env.FPV_LEDGER_FILE)
  : join(ROOT, "..", "floorplan-ai-private", "02-edge-case-ledger.md");
/** Private documents that must never be committed here, wherever someone drops a copy. */
const NEVER_TRACKED = /(^|\/)(01-research-lessons|02-edge-case-ledger)\.md$/;
const MAP = join(ROOT, "tools", "ledger", "dispositions.json");
const PHASE_FILE = join(ROOT, "tools", "ledger", "current-phase.json");
const OUT = join(ROOT, "docs", "eval", "ledger-coverage.json");

type Disposition = "adopt" | "reverse" | "reject" | "defer" | "omit";
interface Entry {
  from: string; // e.g. "W-001"
  to?: string; // inclusive; defaults to from
  disposition: Disposition;
  package?: string;
  phase?: number; // phase in which the test is due (defer uses this too)
  note?: string;
}
interface Resolved extends Entry {
  id: string;
}

function parseId(id: string): { prefix: string; n: number } {
  const m = /^([A-Z])-(\d{3})$/.exec(id);
  if (!m) throw new Error(`bad ledger id ${id}`);
  return { prefix: m[1] as string, n: Number(m[2]) };
}

function expand(entries: Entry[]): Map<string, Resolved> {
  const map = new Map<string, Resolved>();
  for (const e of entries) {
    const a = parseId(e.from);
    const b = parseId(e.to ?? e.from);
    if (a.prefix !== b.prefix || b.n < a.n) throw new Error(`bad range ${e.from}..${e.to}`);
    for (let n = a.n; n <= b.n; n += 1) {
      const id = `${a.prefix}-${String(n).padStart(3, "0")}`;
      map.set(id, { ...e, id }); // later entries override earlier ones: exceptions follow ranges
    }
  }
  return map;
}

function ledgerIds(): string[] {
  const text = readFileSync(LEDGER, "utf8");
  const ids = new Set<string>();
  for (const m of text.matchAll(/^([A-Z]-\d{3}) \|/gm)) ids.add(m[1] as string);
  return [...ids].sort();
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "dist") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function testedIds(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const dirs = [join(ROOT, "packages"), join(ROOT, "apps"), join(ROOT, "tools", "test")];
  for (const file of dirs.flatMap((d) => walk(d))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b([WORFPCS]-\d{3})\b/g)) {
      const id = m[1] as string;
      const list = found.get(id) ?? [];
      const rel = file.slice(ROOT.length).replaceAll("\\", "/");
      if (!list.includes(rel)) list.push(rel);
      found.set(id, list);
    }
  }
  return found;
}

// Checked before anything else and whether or not the ledger is present: the rule protects the public
// history, and a copy committed by accident is exactly the case where the private folder may be missing.
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((f) => NEVER_TRACKED.test(f));
if (tracked.length > 0) {
  console.error(`ledger: private documents are tracked in this repository: ${tracked.join(", ")}`);
  console.error("  remove them with `git rm --cached` and keep them in ../floorplan-ai-private");
  process.exit(1);
}
if (!existsSync(LEDGER)) {
  console.log(`ledger: ${LEDGER} not found, coverage report skipped (the ledger is kept privately)`);
  process.exit(0);
}

const args = new Set(process.argv.slice(2));
const phaseCfg = existsSync(PHASE_FILE)
  ? (JSON.parse(readFileSync(PHASE_FILE, "utf8")) as { phase: number; gate: boolean })
  : { phase: 0, gate: false };
const strict = args.has("--strict") || phaseCfg.gate;
const currentPhase = phaseCfg.phase;

const ids = ledgerIds();
const map = expand(JSON.parse(readFileSync(MAP, "utf8")) as Entry[]);
const tests = testedIds();

const rows = ids.map((id) => {
  const d = map.get(id);
  const files = tests.get(id) ?? [];
  const due = d?.phase ?? 0;
  const needsTest = d ? d.disposition !== "omit" : true;
  const status = !d
    ? "unmapped"
    : d.disposition === "omit"
      ? "omitted"
      : files.length > 0
        ? "covered"
        : due > currentPhase
          ? "deferred"
          : "missing";
  return {
    id,
    disposition: d?.disposition ?? null,
    package: d?.package ?? null,
    phase: due,
    files,
    needsTest,
    status,
  };
});

const byPackage = new Map<
  string,
  { covered: number; missing: number; deferred: number; omitted: number; unmapped: number }
>();
for (const r of rows) {
  const key = r.package ?? "(none)";
  const b = byPackage.get(key) ?? { covered: 0, missing: 0, deferred: 0, omitted: 0, unmapped: 0 };
  b[r.status as keyof typeof b] += 1;
  byPackage.set(key, b);
}

console.log(`ledger: ${ids.length} ids, phase ${currentPhase}${strict ? " (strict)" : " (report only)"}`);
for (const [pkg, b] of [...byPackage.entries()].sort()) {
  console.log(
    `  ${pkg.padEnd(12)} covered ${String(b.covered).padStart(3)}  missing ${String(b.missing).padStart(3)}  deferred ${String(b.deferred).padStart(3)}  omitted ${String(b.omitted).padStart(3)}  unmapped ${String(b.unmapped).padStart(3)}`,
  );
}
const missing = rows.filter((r) => r.status === "missing");
const unmapped = rows.filter((r) => r.status === "unmapped");
if (unmapped.length) console.log(`  unmapped ids: ${unmapped.map((r) => r.id).join(", ")}`);
if (missing.length)
  console.log(`  missing for phase <= ${currentPhase}: ${missing.map((r) => r.id).join(", ")}`);

mkdirSync(join(ROOT, "docs", "eval"), { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), phase: currentPhase, rows }, null, 2)}\n`,
);

if (strict && (missing.length > 0 || unmapped.length > 0)) {
  console.error(`ledger coverage: ${missing.length} missing, ${unmapped.length} unmapped`);
  process.exit(1);
}
