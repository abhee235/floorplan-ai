// History, batch, session and export tools (spec 04 section 8) plus the tools that need a service this
// session may not have: render, verify_product, get_bom, furnish_room, create_room_from_brief (ADR-006 D2).
import {
  getBom as computeBom,
  parseBomScope,
  VerifyInputError,
  type VerifyRequest,
  VerifyUnavailable,
} from "@fpv/catalog";
import { SCHEMA_VERSION } from "@fpv/ir";
import { z } from "zod";
import { invalidArg, ToolError, unavailable } from "../envelope.js";
import { blankProject } from "../project.js";

/** Host file errors carry code, message and hint; anything else becomes file.error. */
function toToolError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const s = e as { code: string; message: string; hint?: string | null };
    return new ToolError(String(s.code), s.message, null, s.hint ?? null);
  }
  return new ToolError("file.error", e instanceof Error ? e.message : String(e));
}

import { defineTool, TIMEOUTS } from "../registry.js";

const RefS = z.object({ type: z.string(), id: z.string() });
const ChangeSetS = z.object({
  commandType: z.string(),
  added: z.array(RefS),
  updated: z.array(RefS),
  removed: z.array(RefS),
});

export const history = defineTool({
  name: "history",
  description:
    "Undo and redo, or checkpoints: 'checkpoint' saves the current state under a label and returns its id, 'restore' returns to one (undoable), 'list' shows history entries and checkpoints. Call checkpoint before a large batch.",
  tier: "both",
  mutating: true,
  input: z.object({
    op: z.enum(["checkpoint", "undo", "redo", "list", "restore"]),
    label: z.string().optional().describe("for checkpoint, e.g. 'before furnishing room_000001'"),
    checkpointId: z.string().optional().describe("for restore, from a checkpoint result"),
  }),
  output: z.object({
    position: z.number(),
    entries: z.array(z.object({ label: z.string(), at: z.string() })).optional(),
    checkpoints: z.array(z.object({ id: z.string(), label: z.string(), at: z.string() })).optional(),
    checkpointId: z.string().optional(),
    changed: ChangeSetS.nullable().optional(),
  }),
  run(args, call) {
    const store = call.ctx.store;
    switch (args.op) {
      case "checkpoint": {
        const id = store.checkpoint(args.label ?? `checkpoint ${store.historyPosition}`);
        return { position: store.historyPosition, checkpointId: id };
      }
      case "undo": {
        const changed = store.undo();
        if (!changed) call.warn("nothing to undo");
        call.changed(changed);
        return { position: store.historyPosition, changed };
      }
      case "redo": {
        const changed = store.redo();
        if (!changed) call.warn("nothing to redo");
        call.changed(changed);
        return { position: store.historyPosition, changed };
      }
      case "list":
        return {
          position: store.historyPosition,
          entries: store.entries().map((e) => ({ label: e.label, at: e.at })),
          checkpoints: store.listCheckpoints(),
        };
      case "restore": {
        if (!args.checkpointId) throw invalidArg("checkpointId", "required for restore");
        const changed = store.restore(args.checkpointId);
        if (!changed)
          throw new ToolError(
            "ref.missing",
            `checkpoint "${args.checkpointId}" does not exist`,
            null,
            "history op 'list' shows checkpoints",
          );
        call.changed(changed);
        return { position: store.historyPosition, changed };
      }
    }
  },
});

export const batch = defineTool({
  name: "batch",
  description:
    "Run several tool calls as one step: calls is a list of { name, args } with the same arguments you would give each tool, e.g. [{ name: 'place_item', args: {...} }, ...], up to 200. If one fails, everything the earlier ones did is undone and the error names which. Use it for a room's items or for the same call across many rooms.",
  tier: "both",
  mutating: true,
  input: z.object({
    label: z.string().optional(),
    calls: z
      .array(z.object({ name: z.string(), args: z.unknown().optional() }))
      .min(1)
      .max(200)
      .optional()
      .describe("tool calls, in order: [{ name: 'place_item', args: { roomId, productId, anchor } }, ...]"),
    commands: z
      .array(z.object({ type: z.string(), payload: z.unknown() }))
      .min(1)
      .max(200)
      .optional()
      .describe("raw store commands as data, for callers that speak spec 03; most callers want calls"),
  }),
  output: z.object({
    applied: z.number(),
    changed: ChangeSetS.nullable(),
    results: z.array(z.unknown()).optional(),
  }),
  async run(args, call) {
    if (args.calls) {
      if (args.commands) throw invalidArg("commands", "give calls or commands, not both");
      // Atomic the way the registry makes a refused call atomic: remember where the history was,
      // and undo back to it when a call fails. A real run sent batch the arguments of place_item
      // twice and was refused twice for a field it had never heard of (ADR-027 D6).
      const store = call.ctx.store;
      const before = store.historyPosition;
      const results: unknown[] = [];
      for (const [i, c] of args.calls.entries()) {
        if (c.name === "batch") throw invalidArg("calls", `call ${i + 1} is a batch inside a batch`);
        const r = await call.tools.call(c.name, c.args ?? {});
        for (const w of r.warnings) call.warn(`call ${i + 1} (${c.name}): ${w}`);
        if (!r.ok) {
          while (store.historyPosition > before) store.undo();
          throw new ToolError(
            r.error.code,
            `call ${i + 1} of ${args.calls.length} (${c.name}) failed and the ${i} before it were undone: ${r.error.message}`,
            r.error.entityId,
            r.error.hint,
          );
        }
        results.push(r.result);
      }
      call.changed(null);
      return { applied: args.calls.length, changed: null, results };
    }
    if (!args.commands) throw invalidArg("calls", "give calls: [{ name, args }, ...]");
    const t = call.ctx.store.transaction(args.label ?? "batch", args.commands, call.origin);
    if (!t.ok)
      throw new ToolError(
        t.error.code,
        `command ${t.failedIndex + 1} of ${args.commands.length}: ${t.error.message}`,
        t.error.entityId,
        t.error.hint,
      );
    for (const r of t.results) for (const w of r.warnings) call.warn(w);
    call.changed(t.entry?.changes ?? null);
    return { applied: args.commands.length, changed: t.entry?.changes ?? null };
  },
});

export const project = defineTool({
  name: "project",
  description:
    "Session operations: 'info' returns the project name, path and modified flag; 'new' starts an empty project with one level; 'open' reads a project directory (recover: true takes a newer recovery file when one is reported); 'save' writes the project directory atomically.",
  tier: "both",
  mutating: true,
  input: z.object({
    op: z.enum(["new", "open", "save", "info"]),
    path: z.string().optional().describe("project directory for open or save"),
    name: z.string().optional().describe("name for a new project"),
    recover: z.boolean().optional().describe("with open: load the newer recovery file instead"),
  }),
  output: z.object({
    path: z.string().nullable(),
    name: z.string(),
    modified: z.boolean(),
    schemaVersion: z.number(),
    lastSavedAt: z.string().nullable(),
    recoveryAvailable: z.string().nullable(),
    modifiedOutside: z.boolean(),
  }),
  async run(args, call) {
    const { store, files } = call.ctx;
    const info = (modifiedOutside = false) => ({
      path: files?.path() ?? null,
      name: store.project.meta.name,
      modified: store.modified,
      schemaVersion: SCHEMA_VERSION,
      lastSavedAt: files?.lastSavedAt() ?? null,
      recoveryAvailable: files?.recoveryAt() ?? null,
      modifiedOutside,
    });
    // The agent works in the project it was asked in. A model that "starts a new project" swaps the
    // session's project for a blank one with a new id and no folder, so everything it then builds is
    // watched by the tab and saved nowhere; two real runs did exactly that on an empty project.
    if (call.origin === "agent" && (args.op === "new" || args.op === "open"))
      throw unavailable(
        "project",
        `the agent may not ${args.op} a project: the one it was asked in is the one to build in`,
        "call get_scene and build here; a person starts or opens a project from the editor",
      );
    switch (args.op) {
      case "info":
        return info();
      case "new":
        store.load(blankProject(args.name ?? "Untitled", call.ctx.now()));
        // Before anything else: what is open now has no file, and a save must ask where to put it
        // rather than writing over whatever was open a moment ago.
        files?.forget?.();
        call.changed({
          commandType: "project.new",
          added: [],
          updated: [{ type: "meta", id: "project" }],
          removed: [],
        });
        return info();
      case "open": {
        if (!files)
          throw unavailable(
            "project open",
            "this session has no project files (they arrive with the file format)",
          );
        if (!args.path) throw invalidArg("path", "required for open");
        let opened: Awaited<ReturnType<typeof files.open>>;
        try {
          opened = await files.open(args.path, args.recover ? { recover: true } : {});
        } catch (e) {
          throw toToolError(e);
        }
        store.load(opened.project);
        if (opened.recoveryAt && !args.recover)
          call.warn(
            `a recovery file from ${opened.recoveryAt} is newer than the saved project; open again with recover: true to use it`,
          );
        if (opened.modifiedOutside)
          call.warn("project.json was modified outside the app (manifest hash mismatch)");
        if (opened.manifestMissing) call.warn("no manifest.json; it will be written on the next save");
        if (opened.migrated) call.warn("the file was migrated to the current schema; save to keep it");
        call.changed({
          commandType: "project.open",
          added: [],
          updated: [{ type: "meta", id: "project" }],
          removed: [],
        });
        return info(opened.modifiedOutside);
      }
      case "save": {
        if (!files)
          throw unavailable(
            "project save",
            "this session has no project files (they arrive with the file format)",
          );
        try {
          await files.save(args.path ?? null);
        } catch (e) {
          throw toToolError(e);
        }
        return info();
      }
    }
  },
});

export const render = defineTool({
  name: "render",
  description:
    "Render images through the connected viewer. 'plan' is a fast top-down drawing; 'overhead' returns four angled views with walls hidden so furniture is visible; 'room' focuses a room; 'eye' is a standing viewpoint inside a room. Fails with a clear message if no viewer is connected; then rely on get_scene and validate.",
  tier: "both",
  mutating: false,
  timeoutMs: TIMEOUTS.render,
  resultCapBytes: 32 * 1024 * 1024, // four PNGs at up to 4096 px wide; images travel as MCP image blocks
  input: z.object({
    view: z.enum(["plan", "overhead", "room", "eye"]),
    focusId: z.string().optional().describe("room or item id to focus"),
    hideWalls: z.boolean().optional(),
    width: z.number().int().min(64).max(4096).optional().describe("image width in px, default 1024"),
  }),
  output: z.object({
    views: z.array(z.object({ name: z.string(), width: z.number(), height: z.number() })),
    images: z.array(
      z.object({ name: z.string(), width: z.number(), height: z.number(), pngBase64: z.string() }),
    ),
  }),
  async run(args, call) {
    const viewer = call.ctx.viewer;
    if (!viewer)
      throw unavailable(
        "render",
        "no viewer is connected",
        "continue with get_scene and validate; open the web app to enable rendering",
      );
    const req = {
      view: args.view,
      ...(args.focusId !== undefined ? { focusId: args.focusId } : {}),
      ...(args.hideWalls !== undefined ? { hideWalls: args.hideWalls } : {}),
      ...(args.width !== undefined ? { width: args.width } : {}),
    };
    const { images } = await viewer.render(req);
    return { views: images.map((i) => ({ name: i.name, width: i.width, height: i.height })), images };
  },
});

export const verifyProduct = defineTool({
  name: "verify_product",
  description:
    "Verify that a make and model exist and capture dimensions, specs and price from the web. Returns the productId to use, or 'unverified' with what was found, or 'rejected' when no page names the model. Values count only when a fetched page states them. If you can search the web yourself, pass sources (product or spec page URLs) and optionally proposal (the fields you read, with fieldSources). Unavailable if no search provider is configured and no sources are given.",
  tier: "both",
  // the project is untouched; the catalog gains or updates a record
  mutating: false,
  timeoutMs: TIMEOUTS.slow,
  input: z.object({
    make: z.string().min(1).describe("manufacturer, e.g. 'Samsung'"),
    model: z.string().min(1).describe("model number as the manufacturer writes it, e.g. 'QM75C'"),
    category: z.string().optional().describe("e.g. display, video-bar, ceiling-mic"),
    sources: z
      .array(z.string().url())
      .max(5)
      .optional()
      .describe("page URLs to read instead of searching; the manufacturer's spec page first"),
    proposal: z
      .object({})
      .passthrough()
      .optional()
      .describe(
        "fields read from the sources: { found, make, model, name, category, dims: { w, d, h } mm, weightKg, mount: { kinds, vesa }, specs, price: { amount, currency, sourceUrl }, fieldSources: { dims: url } }",
      ),
    force: z
      .boolean()
      .optional()
      .describe("re-verify even if the catalog already has a current verified record"),
  }),
  output: z.object({
    productId: z.string().nullable(),
    status: z.enum(["verified", "unverified", "rejected", "manual"]),
    confidence: z.number(),
    product: z.unknown().nullable(),
    sources: z.array(z.string()),
    notes: z.array(z.string()),
    cached: z.boolean(),
    runId: z.string().nullable(),
    proposal: z.unknown().nullable(),
  }),
  async run(args, { ctx }) {
    if (!ctx.verifier)
      throw unavailable(
        "verify_product",
        "no search provider is configured",
        "place the item as a recipe from search_catalog kind 'recipe' and note the make and model in tags",
      );
    try {
      const out = await ctx.verifier.verify({
        make: args.make,
        model: args.model,
        ...(args.category ? { category: args.category } : {}),
        ...(args.sources ? { sources: args.sources } : {}),
        ...(args.proposal ? { proposal: args.proposal as NonNullable<VerifyRequest["proposal"]> } : {}),
        ...(args.force ? { force: true } : {}),
      });
      return {
        productId: out.productId,
        status: out.status,
        confidence: out.confidence,
        product: out.product,
        sources: out.sources,
        notes: out.notes,
        cached: out.cached,
        runId: out.runId,
        proposal: out.proposal,
      };
    } catch (e) {
      if (e instanceof VerifyUnavailable) throw unavailable("verify_product", e.because, e.hint);
      if (e instanceof VerifyInputError) throw invalidArg(e.field, e.message.slice(e.field.length + 2));
      throw e;
    }
  },
});

export const getBom = defineTool({
  name: "get_bom",
  description:
    "Bill of materials for the project, a level, or a room, computed from placed items, openings and the rules pack. Lines carry the reason (item id or rule id). Unverified products are flagged.",
  tier: "both",
  mutating: false,
  input: z.object({
    scope: z.string().describe("'project', 'level:<id>' or 'room:<id>'"),
    includeUnverified: z.boolean().optional(),
    explain: z.boolean().optional(),
  }),
  output: z.object({}).passthrough(),
  run(args, { ctx }) {
    if (!ctx.rules)
      throw unavailable(
        "get_bom",
        "no rules pack is loaded in this session",
        "use get_scene with types ['item'] to list what is placed",
      );
    const scope = parseBomScope(args.scope);
    if (!scope)
      throw invalidArg(
        "scope",
        `"${args.scope}" is not a scope`,
        "use 'project', 'level:<id>' or 'room:<id>'",
      );
    const p = ctx.store.project;
    if (scope.kind === "room" && !p.rooms.some((r) => r.id === scope.id))
      throw new ToolError(
        "ref.missing",
        `room "${scope.id}" does not resolve`,
        null,
        "use get_scene detail summary",
      );
    if (scope.kind === "level" && !p.levels.some((l) => l.id === scope.id))
      throw new ToolError(
        "ref.missing",
        `level "${scope.id}" does not resolve`,
        null,
        "use get_scene detail summary",
      );
    const bom = computeBom(p, ctx.rules, {
      now: ctx.now(),
      catalog: ctx.catalog,
      scope,
      explain: args.explain ?? false,
    });
    if (args.includeUnverified === false)
      return { ...bom, lines: bom.lines.filter((l) => l.status === "verified" || l.status === "labour") };
    return bom;
  },
});
