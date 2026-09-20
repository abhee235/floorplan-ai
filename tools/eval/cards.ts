// Task cards and their scoring for the agent evaluation (ADR-007 D5, PRD P1-8). A card is a task sentence, a step
// budget and what the finished project must contain. A score records how the run stopped, its cost (steps, tool
// calls, tokens, seconds) and what is missing; a run passes when it finished inside the budget with nothing
// missing and no more validation errors than the card allows.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentRun } from "@fpv/agents";
import { getBom } from "@fpv/catalog";
import { derive, type Item, type Project } from "@fpv/ir";
import type { Session } from "../../apps/host/src/session.js";

export const CARDS_DIR = fileURLToPath(new URL("./cards/", import.meta.url));

export interface ExpectedRoom {
  name?: string;
  purpose?: string;
  minCapacity?: number;
  /** Inclusive range in square metres. */
  areaM2?: [number, number];
}

export interface TaskCard {
  id: string;
  title: string;
  task: string;
  maxSteps: number;
  expect: {
    rooms?: ExpectedRoom[];
    /** Item categories that must be present at least once. */
    categories?: string[];
    minCounts?: Record<string, number>;
    minWalls?: number;
    /** Null leaves validation unchecked. */
    maxValidationErrors?: number | null;
    /**
     * At most this many warnings of each code (ADR-024 D6).
     *
     * The placement faults a run can pass `validate` with and still be a bad drawing: a room with a
     * side no wall runs along, a wardrobe across a door, a bed with nothing behind its head. They
     * are warnings because a person dragging their own furniture must not be refused, so a card is
     * where the agent is held to them.
     */
    maxWarnings?: Record<string, number>;
  };
}

export function loadCards(ids?: readonly string[]): TaskCard[] {
  const all = readdirSync(CARDS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(`${CARDS_DIR}${f}`, "utf8")) as TaskCard);
  if (!ids?.length) return all;
  const missing = ids.filter((id) => !all.some((c) => c.id === id));
  if (missing.length) throw new Error(`no task card named ${missing.join(", ")}`);
  return all.filter((c) => ids.includes(c.id));
}

/** Item category as furnishing counts it: the recipe kind, or the product snapshot's category. */
export function categoryOf(item: Item, project: Project): string {
  if (item.ref.kind === "recipe") {
    const k = item.ref.recipe.kind;
    return k === "box" || k === "cylinder" ? "other" : k;
  }
  return (project.catalogRefs[item.ref.productId] as { category?: string } | undefined)?.category ?? "other";
}

export interface CardScore {
  card: string;
  model: string;
  provider: string;
  reliability: string;
  at: string;
  reason: string;
  error: string | null;
  steps: number;
  maxSteps: number;
  toolCalls: number;
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  seconds: number;
  validationErrors: number;
  /** How many of each warning code the finished drawing has, for the codes a card names. */
  warningCounts: Record<string, number>;
  walls: number;
  rooms: number;
  items: number;
  missing: string[];
  bomLines: number;
  /** Share of product BOM lines (labour excluded) that are verified; null without lines. */
  bomVerified: number | null;
  pass: boolean;
  /** Runner warnings, such as a prompt the server cut to its context length. */
  warnings: string[];
  transcript: string | null;
}

export interface ScoreMeta {
  model: string;
  provider: string;
  reliability: string;
  at: string;
  seconds: number;
  transcript: string | null;
}

function roomMatches(project: Project, want: ExpectedRoom, taken: Set<string>): string | null {
  const hit = project.rooms.find((r) => {
    if (taken.has(r.id)) return false;
    if (want.name && (r.name ?? "").trim().toLowerCase() !== want.name.toLowerCase()) return false;
    if (want.purpose && r.purpose !== want.purpose) return false;
    if (want.minCapacity !== undefined && (r.capacity ?? 0) < want.minCapacity) return false;
    if (want.areaM2) {
      const a = derive.roomArea(r) / 1e6;
      if (a < want.areaM2[0] || a > want.areaM2[1]) return false;
    }
    return true;
  });
  return hit?.id ?? null;
}

const describeRoom = (w: ExpectedRoom) =>
  [
    w.name ? `"${w.name}"` : null,
    w.purpose ?? null,
    w.minCapacity !== undefined ? `${w.minCapacity}+ seats` : null,
    w.areaM2 ? `${w.areaM2[0]}-${w.areaM2[1]} m2` : null,
  ]
    .filter(Boolean)
    .join(" ");

export function scoreCard(card: TaskCard, session: Session, run: AgentRun, meta: ScoreMeta): CardScore {
  const project = session.store.project;
  const missing: string[] = [];
  const taken = new Set<string>();
  for (const want of card.expect.rooms ?? []) {
    const id = roomMatches(project, want, taken);
    if (id) taken.add(id);
    else missing.push(`room ${describeRoom(want)}`);
  }
  const counts = new Map<string, number>();
  for (const item of project.items) {
    const c = categoryOf(item, project);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  for (const c of card.expect.categories ?? []) if (!counts.has(c)) missing.push(c);
  for (const [c, n] of Object.entries(card.expect.minCounts ?? {}))
    if ((counts.get(c) ?? 0) < n) missing.push(`${n} ${c} (found ${counts.get(c) ?? 0})`);
  if (card.expect.minWalls !== undefined && project.walls.length < card.expect.minWalls)
    missing.push(`${card.expect.minWalls} walls (found ${project.walls.length})`);
  const problems = session.registry.problems();
  const validationErrors = problems.filter((p) => p.severity === "error").length;
  const warningCounts: Record<string, number> = {};
  for (const [code, limit] of Object.entries(card.expect.maxWarnings ?? {})) {
    const n = problems.filter((p) => p.severity === "warning" && p.code === code).length;
    warningCounts[code] = n;
    if (n > limit) missing.push(`at most ${limit} ${code} (found ${n})`);
  }
  let bomLines = 0;
  let bomVerified: number | null = null;
  if (session.ctx.rules && project.items.length > 0) {
    const bom = getBom(project, session.ctx.rules, {
      now: meta.at,
      catalog: session.ctx.catalog,
      scope: { kind: "project" },
      explain: false,
    });
    // labour lines have nothing to verify
    const products = bom.lines.filter((l) => l.status !== "labour");
    bomLines = products.length;
    if (bomLines > 0) bomVerified = products.filter((l) => l.status === "verified").length / bomLines;
  }
  const maxErrors = card.expect.maxValidationErrors;
  const pass =
    run.reason === "done" &&
    run.steps <= card.maxSteps &&
    missing.length === 0 &&
    (maxErrors === null || maxErrors === undefined || validationErrors <= maxErrors);
  return {
    card: card.id,
    model: meta.model,
    provider: meta.provider,
    reliability: meta.reliability,
    at: meta.at,
    reason: run.reason,
    error: run.error,
    steps: run.steps,
    maxSteps: card.maxSteps,
    toolCalls: run.toolCalls,
    failedCalls: run.failedCalls,
    promptTokens: run.usage.promptTokens,
    completionTokens: run.usage.completionTokens,
    seconds: Math.round(meta.seconds),
    validationErrors,
    warningCounts,
    walls: project.walls.length,
    rooms: project.rooms.length,
    items: project.items.length,
    missing,
    bomLines,
    bomVerified,
    pass,
    warnings: run.events.flatMap((e) => (e.type === "warning" ? [e.message] : [])),
    transcript: meta.transcript,
  };
}

const START = "<!-- runs:start -->";
const END = "<!-- runs:end -->";

/** The latest score per card, model and profile, as a Markdown table. */
export function renderRunsTable(scores: readonly CardScore[]): string {
  const latest = new Map<string, CardScore>();
  for (const s of scores) {
    const key = `${s.card}|${s.model}|${s.reliability}`;
    const prev = latest.get(key);
    if (!prev || prev.at <= s.at) latest.set(key, s);
  }
  const rows = [...latest.values()].sort(
    (a, b) =>
      a.card.localeCompare(b.card) ||
      a.model.localeCompare(b.model) ||
      a.reliability.localeCompare(b.reliability),
  );
  const lines = [
    "| Card | Model | Profile | Result | Steps | Tool calls (failed) | Tokens in / out | Seconds | Validation errors | Missing | BOM verified | Date |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const s of rows)
    lines.push(
      `| ${s.card} | ${s.model} | ${s.reliability} | ${s.pass ? "pass" : `fail (${s.reason})`} | ${s.steps} of ${s.maxSteps} | ${s.toolCalls} (${s.failedCalls}) | ${s.promptTokens} / ${s.completionTokens} | ${s.seconds} | ${s.validationErrors} | ${s.missing.length ? s.missing.join("; ") : "none"} | ${s.bomVerified === null ? "-" : `${Math.round(s.bomVerified * 100)}% of ${s.bomLines}`} | ${s.at.slice(0, 10)} |`,
    );
  return lines.join("\n");
}

/** Replace the table between the run markers, keeping the rest of the document. */
export function mergeRunsSection(markdown: string, table: string): string {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start < 0 || end < start) return `${markdown.trimEnd()}\n\n${START}\n${table}\n${END}\n`;
  return `${markdown.slice(0, start)}${START}\n${table}\n${markdown.slice(end)}`;
}
