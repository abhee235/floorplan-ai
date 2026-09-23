// The live eval loop (ADR-028 D11): one brief, run through a host exactly as a person's editor runs
// it, then looked at and scored.
//
// The headless cards in run.ts drive the loop in-process with a session of their own. This drives a
// host over its bridge, as a browser tab does, so what it measures is the product: the designer, the
// architect sub-run, the skills, the notes, the look gate and the builder, with the model the host
// is configured for. The run is watchable in the editor at the same time, on the same host.
//
//   tsx tools/eval/live.ts --host ws://127.0.0.1:4311/bridge --card office-brief-live --out <dir>
//
// It prints one line per step, so a watcher can follow along, and writes into <dir>: events.jsonl,
// every picture the agent looked at, built.png (the level as built, furniture included),
// project.json, and report.md with each check PASS or FAIL. It exits 0 only when every check passes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@fpv/ir";
import { categoryOf, describeRoom, loadCards, roomMatches } from "./cards.js";

/** A bridge message, read as JSON and checked where it is used. */
type Msg = any;

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v !== undefined) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
};

const hostUrl = arg("--host", "ws://127.0.0.1:4311/bridge");
const card = loadCards([arg("--card", "office-brief-live")])[0];
if (!card) throw new Error("no such card");
const out = arg("--out");
const timeoutMin = Number(arg("--timeout-min", "150"));
const task = arg("--text", card.task);
mkdirSync(join(out, "pictures"), { recursive: true });

const say = (line: string) => process.stdout.write(`${line}\n`);
const short = (s: unknown, n = 140) => {
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return (t ?? "").replace(/\s+/g, " ").slice(0, n);
};

// ---- the bridge ------------------------------------------------------------------------------------
const ws = new WebSocket(hostUrl);
const pending = new Map<string, (m: Msg) => void>();
const events: Msg[] = [];
let project: Project | null = null;
let n = 0;
let pictures = 0;
const eventsFile = join(out, "events.jsonl");
writeFileSync(eventsFile, "");

ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data)) as Msg;
  if (m.type === "snapshot") project = m.project;
  if (m.type === "agent.event") onEvent(m);
  if (m.id && pending.has(m.id)) {
    const resolve = pending.get(m.id) as (m: Msg) => void;
    pending.delete(m.id);
    resolve(m);
  }
};
const request = (body: Record<string, unknown>, ms = 600_000): Promise<Msg> =>
  new Promise((resolve, reject) => {
    const id = `eval${++n}`;
    const timer = setTimeout(() => reject(new Error(`no answer to ${String(body.type)} in ${ms} ms`)), ms);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    ws.send(JSON.stringify({ id, ...body }));
  });
/** A tool called as the editor calls it; the bridge wraps the tool's envelope in its own reply. */
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await request({ type: "tool", name, args });
  return r.ok ? r.result?.result : { __error: r.error };
};

function onEvent(m: Msg): void {
  events.push(m);
  const { event } = m;
  const who = m.by ?? "designer";
  // the pictures go to files; the event keeps a pointer, not a megabyte of base64
  if (event.type === "tool.finished" && event.display?.kind === "image") {
    const file = `${String(++pictures).padStart(2, "0")}-${who}-${event.name}.png`;
    writeFileSync(
      join(out, "pictures", file),
      Buffer.from(String(event.display.dataUrl).split(",")[1] ?? "", "base64"),
    );
    event.display = { kind: "image", file, caption: event.display.caption };
    say(`  picture saved: pictures/${file}`);
  }
  const { event: _drop, ...rest } = m;
  writeFileSync(eventsFile, `${JSON.stringify({ ...rest, event })}\n`, { flag: "a" });
  switch (event.type) {
    case "tool.started":
      say(`[${who}] #${event.step} ${event.name} ${short(event.summary ?? event.args, 110)}`);
      break;
    case "tool.finished":
      if (!event.ok)
        say(`[${who}]   FAILED ${event.name}: ${short(event.error?.message ?? event.preview, 200)}`);
      else if (event.warnings?.length)
        say(`[${who}]   ${event.name} warns: ${short(event.warnings[0], 200)}`);
      break;
    case "warning":
      say(`[${who}] warning: ${short(event.message, 240)}`);
      break;
    case "reminder":
      say(`[${who}] gate ${event.gate}: ${short(event.text, 160)}`);
      break;
    case "message":
      say(`[${who}] says: ${short(event.text, 300)}`);
      break;
    case "run.finished":
      say(
        `[${who}] run.finished ${event.reason} steps=${event.steps} tools=${event.toolCalls} failed=${event.failedCalls}`,
      );
      break;
    default:
  }
}

// ---- the run ---------------------------------------------------------------------------------------
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error(`cannot reach ${hostUrl}`));
});
await request({ type: "hello", clientVersion: "eval-live", capabilities: ["plan"] });
const made = await request({
  type: "workspace",
  op: "new",
  name: `eval ${card.id} ${new Date().toISOString().slice(0, 16)}`,
});
if (!made.ok) throw new Error(`could not make a project: ${short(made.error)}`);
const projectId: string = made.result?.id ?? made.result?.projectId ?? "?";
say(`project ${projectId} on ${hostUrl}`);
const started = Date.now();
const go = await request({ type: "agent", op: "start", text: task });
if (!go.ok) throw new Error(`the agent did not start: ${short(go.error)}`);
say(`run ${go.result?.runId ?? "?"} started`);

const deadline = Date.now() + timeoutMin * 60_000;
while (!events.some((m) => m.event.type === "run.finished" && !m.by) && Date.now() < deadline)
  await new Promise((r) => setTimeout(r, 500));
const finished = events.find((m) => m.event.type === "run.finished" && !m.by)?.event;
if (!finished) {
  say("TIMEOUT: cancelling the run");
  await request({ type: "agent", op: "cancel" }).catch(() => null);
}
const minutes = Math.round((Date.now() - started) / 600) / 100;

// ---- what was built ---------------------------------------------------------------------------------
await request({ type: "get", what: "snapshot" });
await new Promise((r) => setTimeout(r, 300));
const p = project as Project | null;
if (!p) throw new Error("no snapshot");
writeFileSync(join(out, "project.json"), JSON.stringify(p));
const built = await tool("preview_design", {});
const png = built?.images?.[0]?.pngBase64;
if (png) writeFileSync(join(out, "built.png"), Buffer.from(png, "base64"));
const validation = await tool("validate", {});
const designer = events.filter((m) => !m.by);
const architect = events.filter((m) => m.by === "architect");
const startedCalls = (list: Msg[], name: string) =>
  list.filter((m) => m.event.type === "tool.started" && m.event.name === name);
const buildCall = startedCalls(designer, "build_design").at(-1)?.event;
const builtId: string | null = (buildCall?.args as { designId?: string } | undefined)?.designId ?? null;
const buildOk = designer.some(
  (m) => m.event.type === "tool.finished" && m.event.name === "build_design" && m.event.ok,
);
const walkReport = builtId ? await tool("revise_design", { designId: builtId }) : null;
const walk = walkReport?.walk as
  | {
      entrances: string[];
      through: string[];
      unreached: string[];
      sides: Record<string, { facade: string; enclosed: number; empty: number; along: string[] }>;
      displays: Record<string, string>;
    }
  | undefined;

// ---- the checks -------------------------------------------------------------------------------------
interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

check(
  "the run finished by itself",
  finished?.reason === "done",
  `reason ${finished?.reason ?? "timeout"}, ${finished?.steps ?? "?"} steps, ${minutes} min`,
);
check("a checked design was built", Boolean(builtId && buildOk), builtId ?? "no build_design");
const handDrawn = ["create_walls", "add_opening", "create_room"].map(
  (t) => [t, startedCalls(designer, t).length] as const,
);
check(
  "nothing drawn by hand",
  handDrawn.every(([, k]) => k === 0),
  handDrawn.map(([t, k]) => `${t} ${k}`).join(", "),
);
const previewed = new Set(
  startedCalls(architect, "preview_design").map(
    (m) => (m.event.args as { designId?: string } | undefined)?.designId,
  ),
);
check(
  "the architect looked at the design it handed on",
  builtId !== null && previewed.has(builtId),
  `previewed ${[...previewed].join(", ") || "nothing"}`,
);
const verdicts = architect
  .filter((m) => m.event.type === "message" && /verdict\s*:/i.test(String(m.event.text)))
  .map((m) => String(m.event.text));
check(
  "the architect wrote a LOOK verdict",
  verdicts.length > 0,
  verdicts.length ? short(verdicts.at(-1), 200) : "none",
);
const buildStep = buildCall?.step ?? Number.POSITIVE_INFINITY;
check(
  "the designer looked at what it built",
  startedCalls(designer, "preview_design").some(
    (m) => m.event.step > buildStep && !(m.event.args as { designId?: string })?.designId,
  ),
  `${startedCalls(designer, "preview_design").length} designer previews`,
);
if (walk) {
  check(
    "every room can be walked to",
    walk.unreached.length === 0,
    walk.unreached.join(", ") || "all reached",
  );
  check(
    "no room is reached only through another",
    walk.through.length === 0,
    walk.through.join("; ") || "none",
  );
  check("there is a way in", walk.entrances.length > 0, walk.entrances.join(", ") || "no entrance");
  const maxEmpty = (card as { look?: { maxEmptySide?: number } }).look?.maxEmptySide ?? 0.35;
  const blank = Object.entries(walk.sides).filter(([, s]) => s.empty > maxEmpty);
  check(
    "no side of the building is blank",
    blank.length === 0,
    Object.entries(walk.sides)
      .map(([k, s]) => `${k} ${s.facade} empty ${s.empty} enclosed ${s.enclosed}`)
      .join("; "),
  );
  const totals = (walkReport as { totals?: { shellM2?: number; unaccountedM2?: number } } | null)?.totals;
  const spare = totals?.shellM2 ? (totals.unaccountedM2 ?? 0) / totals.shellM2 : 0;
  check(
    "little floor belongs to no room",
    spare <= 0.12,
    `${Math.round(totals?.unaccountedM2 ?? 0)} m2 of ${Math.round(totals?.shellM2 ?? 0)} m2 is in no room (${Math.round(spare * 100)}%)`,
  );
  const bad = Object.entries(walk.displays).filter(([, d]) => d.startsWith("none"));
  check(
    "every meeting room has a wall for its screen",
    bad.length === 0,
    Object.entries(walk.displays)
      .map(([k, d]) => `${k}: ${d}`)
      .join("; ") || "no screens",
  );
} else check("the built design could be walked", false, short(walkReport?.__error ?? "no design"));

// screens in the project: on a wall that is not glass and has no window
const walls = new Map(p.walls.map((w) => [w.id, w]));
const screens = p.items.filter((i) => categoryOf(i, p) === "display");
const onGlass = screens.filter((i) => {
  const w = i.mount.targetId ? walls.get(i.mount.targetId) : undefined;
  return (
    w !== undefined &&
    (w.kind === "glass" || p.openings.some((o) => o.wallId === w.id && o.kind === "window"))
  );
});
const standing = screens.filter((i) => i.mount.kind !== "wall");
check(
  "no screen on glass or a window",
  onGlass.length === 0,
  `${screens.length} screens, ${onGlass.length} on glass or a window, ${standing.length} standing`,
);

// the card's own expectations
const taken = new Set<string>();
const missing: string[] = [];
for (const want of card.expect.rooms ?? []) {
  const id = roomMatches(p, want, taken);
  if (id) taken.add(id);
  else missing.push(`room ${describeRoom(want)}`);
}
const counts = new Map<string, number>();
for (const item of p.items) counts.set(categoryOf(item, p), (counts.get(categoryOf(item, p)) ?? 0) + 1);
for (const c of card.expect.categories ?? []) if (!counts.has(c)) missing.push(c);
for (const [c, k] of Object.entries(card.expect.minCounts ?? {}))
  if ((counts.get(c) ?? 0) < k) missing.push(`${k} ${c} (found ${counts.get(c) ?? 0})`);
const called = new Set(
  designer
    .concat(architect)
    .filter((m) => m.event.type === "tool.started")
    .map((m) => m.event.name),
);
for (const t of card.expect.calls?.must ?? []) if (!called.has(t)) missing.push(`a call to ${t}`);
check(
  "the brief's rooms and furniture are there",
  missing.length === 0,
  missing.join("; ") || [...counts].map(([k, v]) => `${k} ${v}`).join(", "),
);
const errors = (validation?.errors ?? []) as { message: string }[];
check(
  "validate reports no errors",
  errors.length <= (card.expect.maxValidationErrors ?? 0),
  `${errors.length} errors${errors.length ? `: ${short(errors[0]?.message, 160)}` : ""}`,
);

// ---- the report -------------------------------------------------------------------------------------
const passed = checks.filter((c) => c.pass).length;
const lines = [
  `# ${card.title}`,
  "",
  `Host ${hostUrl}, project ${projectId}, ${new Date().toISOString()}.`,
  `${passed} of ${checks.length} checks pass.`,
  "",
  "| Check | | Detail |",
  "|---|---|---|",
  ...checks.map((c) => `| ${c.name} | ${c.pass ? "PASS" : "FAIL"} | ${c.detail.replace(/\|/g, "/")} |`),
  "",
  "## The architect's verdict",
  "",
  verdicts.at(-1) ?? "(none)",
  "",
  "## The designer's answer",
  "",
  finished?.text ?? "(none)",
  "",
  "## Pictures",
  "",
  "- built.png: the level as built, furniture included",
  ...[...Array(pictures).keys()].map((i) => `- pictures/${String(i + 1).padStart(2, "0")}-*.png`),
];
writeFileSync(join(out, "report.md"), `${lines.join("\n")}\n`);
say("");
for (const c of checks) say(`${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
say(`${passed}/${checks.length} checks pass; report in ${join(out, "report.md")}`);
ws.close();
process.exit(passed === checks.length ? 0 : 1);
