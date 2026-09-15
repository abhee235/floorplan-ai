// import_plan (spec 04, ADR-011 D3, D5): read a plan into a draft for review, then commit it in one
// transaction once the scale is confirmed. The draft is kept per session so the confirm call can name it.
import type { Store } from "@fpv/commands";
import { applyAnswers, draftId as idOf, PlanDraft, scaleStatus, withScale } from "@fpv/importers";
import { derive } from "@fpv/ir";
import { z } from "zod";
import type { DraftPresentation } from "../context.js";
import { invalidArg, ToolError, unavailable } from "../envelope.js";
import { CommitError, commitDraft } from "../import.js";
import { defineTool, TIMEOUTS } from "../registry.js";

interface Kept {
  draft: PlanDraft;
  presentation: DraftPresentation;
}

/** Drafts under review per session store, newest last; a few are kept so a review can be resumed. */
const KEPT = new WeakMap<Store, { byId: Map<string, Kept>; bySource: Map<string, string> }>();
const KEEP = 8;

function keep(store: Store) {
  let k = KEPT.get(store);
  if (!k) {
    k = { byId: new Map(), bySource: new Map() };
    KEPT.set(store, k);
  }
  return k;
}

function remember(store: Store, kept: Kept, source: string | null) {
  const k = keep(store);
  k.byId.delete(kept.presentation.draftId);
  k.byId.set(kept.presentation.draftId, kept);
  if (source) k.bySource.set(source, kept.presentation.draftId);
  while (k.byId.size > KEEP) k.byId.delete(k.byId.keys().next().value as string);
}

const ScaleArg = z.union([
  z.object({ mmPerUnit: z.number().positive() }).strict(),
  z.object({ units: z.enum(["mm", "cm", "m", "in", "ft"]) }).strict(),
  z.object({ measuredUnits: z.number().positive(), lengthMm: z.number().positive() }).strict(),
]);

const QuestionS = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.string(),
  answer: z.string().nullable(),
});

const Output = z.object({
  status: z.enum(["review", "committed"]),
  draftId: z.string(),
  fileName: z.string().nullable(),
  scale: z.object({
    mmPerUnit: z.number().nullable(),
    detected: z.string(),
    source: z.string(),
    confirmed: z.boolean(),
    reason: z.string(),
  }),
  counts: z.object({ walls: z.number(), openings: z.number(), rooms: z.number(), texts: z.number() }),
  questions: z.array(QuestionS),
  draft: z.unknown().optional(),
  warnings: z.array(z.string()).optional(),
  committed: z
    .object({
      levelId: z.string(),
      wallIds: z.array(z.string()),
      openingIds: z.array(z.string()),
      roomIds: z.array(z.string()),
      labelIds: z.array(z.string()),
      skipped: z.array(z.object({ what: z.string(), idx: z.number(), reason: z.string() })),
      openQuestions: z.array(z.string()),
    })
    .optional(),
  next: z.string(),
});

export const importPlan = defineTool({
  name: "import_plan",
  description:
    "Import a floor plan file (DXF now; PDF and images later) as walls, openings and rooms. First call with path: returns a draft id, the detected scale, counts and questions, and shows the draft in the viewer for review; nothing changes. Then call again with confirm=true and the draftId, answering the scale question (answers: {q1: 'mm'} or 'yes') or passing scale {units} / {mmPerUnit} / {measuredUnits, lengthMm}. A draft commits only when its scale is confirmed by a person or by two agreeing dimension texts. detail='full' returns the whole draft; draft accepts an edited draft.",
  tier: "both",
  mutating: true,
  timeoutMs: TIMEOUTS.slow,
  resultCapBytes: 8 * 1024 * 1024,
  input: z.object({
    path: z.string().optional().describe("plan file path, e.g. plans/level1.dxf"),
    content: z.string().optional().describe("the file's text instead of a path"),
    fileName: z.string().optional().describe("names the content's format, e.g. level1.dxf"),
    page: z.number().int().min(1).optional(),
    draftId: z.string().optional().describe("the draft returned by an earlier call"),
    draft: z.unknown().optional().describe("an edited PlanDraft to use instead of the stored one"),
    scale: ScaleArg.optional(),
    answers: z.record(z.string()).optional().describe("answers by question id, e.g. {q1: 'mm'}"),
    confirm: z.boolean().optional().describe("commit the draft"),
    levelId: z.string().optional().describe("level to import onto; default the lowest level"),
    gapToleranceMm: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("gap closing for room detection in mm; default 20 for CAD plans, 100 for images"),
    detail: z.enum(["summary", "full"]).optional(),
  }),
  output: Output,
  async run(args, call) {
    const { ctx } = call;
    const store = ctx.store;
    const source =
      args.path !== undefined
        ? `path:${args.path}#${args.page ?? 1}`
        : args.content !== undefined
          ? null
          : null;
    let kept: Kept | undefined;
    let fileName: string | null = null;

    if (args.draft !== undefined) {
      const parsed = PlanDraft.safeParse(args.draft);
      if (!parsed.success)
        throw invalidArg(
          "draft",
          `the edited draft does not match PlanDraft: ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      const base = args.draftId ? keep(store).byId.get(args.draftId) : undefined;
      kept = {
        draft: parsed.data,
        presentation: {
          draftId: idOf(parsed.data),
          draft: parsed.data,
          preview: base?.presentation.preview ?? null,
          warnings: base?.presentation.warnings ?? [],
        },
      };
    } else if (args.draftId !== undefined && keep(store).byId.has(args.draftId)) {
      kept = keep(store).byId.get(args.draftId);
    } else if (args.path !== undefined || args.content !== undefined) {
      const known = source ? keep(store).bySource.get(source) : undefined;
      if (known && args.confirm && keep(store).byId.has(known)) kept = keep(store).byId.get(known);
      else {
        if (!ctx.plans) throw unavailable("import_plan", "this session has no plan reader");
        const read = await ctx.plans.read({
          ...(args.path !== undefined ? { path: args.path } : {}),
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.fileName !== undefined ? { fileName: args.fileName } : {}),
          ...(args.page !== undefined ? { page: args.page } : {}),
        });
        fileName = read.fileName;
        const warnings = [
          ...read.report.warnings,
          ...Object.entries(read.report.skipped).map(([type, n]) => `${n} ${type} entities were not read`),
        ];
        kept = {
          draft: read.draft,
          presentation: { draftId: idOf(read.draft), draft: read.draft, preview: read.preview, warnings },
        };
      }
    } else if (args.draftId !== undefined) {
      throw new ToolError(
        "import.draft-unknown",
        `no draft "${args.draftId}" is kept in this session`,
        null,
        "call import_plan with the path again",
      );
    } else
      throw invalidArg(
        "path",
        "give path, content with fileName, or a draftId",
        'e.g. path: "plans/level1.dxf"',
      );

    let draft = (kept as Kept).draft;
    fileName = fileName ?? draft.source.file;
    if (args.answers) {
      const applied = applyAnswers(draft, args.answers);
      draft = applied.draft;
      for (const id of applied.unknownIds) call.warn(`answer "${id}" matches no question`);
      for (const id of applied.unreadable)
        call.warn(
          `the answer to ${id} is not a unit, a number of mm per unit, or yes; the scale is unchanged`,
        );
    }
    if (args.scale) {
      try {
        draft = withScale(draft, args.scale);
      } catch (e) {
        throw invalidArg("scale", e instanceof Error ? e.message : String(e));
      }
    }
    const presentation: DraftPresentation = {
      ...(kept as Kept).presentation,
      draftId: idOf(draft),
      draft,
    };
    remember(store, { draft, presentation }, source);

    const status = scaleStatus(draft);
    const summary = {
      draftId: presentation.draftId,
      fileName,
      scale: {
        mmPerUnit: draft.units.mmPerUnit,
        detected: draft.units.detected,
        source: draft.units.scaleSource,
        confirmed: status.confirmed,
        reason: status.reason,
      },
      counts: {
        walls: draft.walls.length,
        openings: draft.openings.length,
        rooms: draft.rooms.length,
        texts: draft.texts.length,
      },
      questions: draft.questions,
    };

    if (!args.confirm) {
      ctx.viewer?.presentDraft?.(presentation);
      for (const w of presentation.warnings) call.warn(w);
      return {
        status: "review" as const,
        ...summary,
        ...(args.detail === "full" ? { draft } : { draft: { ...draft, texts: [] } }),
        next: status.confirmed
          ? `review the draft, then call import_plan with draftId "${presentation.draftId}" and confirm: true`
          : `confirm the scale (${status.reason}): call import_plan with draftId "${presentation.draftId}", confirm: true and answers or scale`,
      };
    }

    const p = store.project;
    const levelId = args.levelId ?? derive.lowestLevel(p).id;
    if (!p.levels.some((l) => l.id === levelId))
      throw new ToolError(
        "ref.missing",
        `level "${levelId}" does not resolve`,
        null,
        "use get_scene to list levels",
      );
    const existing = p.walls.filter((w) => w.levelId === levelId).length;
    if (existing > 0) call.warn(`level ${levelId} already has ${existing} walls; the plan is added to them`);
    let report: ReturnType<typeof commitDraft>;
    try {
      report = commitDraft(store, draft, {
        levelId,
        label: `import ${fileName ?? "plan"}`,
        now: ctx.now(),
        ...(args.gapToleranceMm !== undefined ? { gapToleranceMm: args.gapToleranceMm } : {}),
      });
    } catch (e) {
      if (e instanceof CommitError) throw new ToolError(e.code, e.message, null, e.hint);
      throw e;
    }
    call.changed(report.entry?.changes ?? null);
    for (const s of report.skipped) call.warn(s.reason);
    ctx.viewer?.presentDraft?.(null);
    keep(store).byId.delete(presentation.draftId);
    return {
      status: "committed" as const,
      ...summary,
      committed: {
        levelId,
        wallIds: report.wallIds,
        openingIds: report.openingIds,
        roomIds: report.roomIds,
        labelIds: report.annotationIds,
        skipped: report.skipped,
        openQuestions: report.questions,
      },
      next: "call validate, then describe_room on the imported rooms",
    };
  },
});
