// The export tool (spec 04 section 8, ADR-013 D2): BOM spreadsheets in phase 1. The exporters return
// bytes; the session's writer (the host) puts them on disk.
import { checkDesign, getBom, parseBomScope } from "@fpv/catalog";
import { bomToExportCsv, bomToXlsx, projectToGlb, provenanceFor, sourceLookup } from "@fpv/exporters";
import { validate } from "@fpv/ir";
import { z } from "zod";
import { sizesFor } from "../context.js";
import { invalidArg, ToolError, unavailable } from "../envelope.js";
import { defineTool, TIMEOUTS, type ToolCall } from "../registry.js";

export const exportTool = defineTool({
  name: "export",
  description:
    "Write the bill of materials to a file: csv or xlsx, with provenance and the verification status of every line. Refuses when validate reports errors unless force is true (the file is then marked DRAFT), and refuses while lines are unverified or placeholders unless includeUnverified is true (the file then says so and highlights them). Relative paths go into the project directory. glb writes the 3D scene as a glTF binary (metres, y up) with one node per level, wall, opening, room and item, named by entity id; it needs no rules pack. pdf and dxf arrive in phase 3. Returns the path and size.",
  tier: "both",
  mutating: false,
  timeoutMs: TIMEOUTS.slow,
  input: z.object({
    format: z.enum(["csv", "xlsx", "glb", "pdf", "dxf"]),
    scope: z.string().optional().describe("'project' (default), 'level:<id>' or 'room:<id>'"),
    path: z.string().min(1).describe("output file, e.g. 'boardroom-bom.xlsx'"),
    force: z.boolean().optional().describe("export despite validation errors; the file is marked DRAFT"),
    includeUnverified: z
      .boolean()
      .optional()
      .describe("allow unverified and placeholder lines; they are highlighted"),
    overwrite: z.boolean().optional().describe("replace an existing file"),
  }),
  output: z.object({
    path: z.string(),
    bytes: z.number(),
    format: z.string(),
    lines: z.number(),
    nodes: z.number().optional(),
    triangles: z.number().optional(),
    draft: z.boolean(),
    includesUnverified: z.boolean(),
    warnings: z.array(z.string()),
  }),
  async run(args, call) {
    const { ctx } = call;
    if (args.format === "glb") return exportGlb(args, call);
    if (args.format !== "csv" && args.format !== "xlsx")
      throw unavailable(
        "export",
        `${args.format} export arrives in phase 3`,
        "use csv or xlsx for the bill of materials, glb for the 3D scene",
      );
    if (!ctx.rules)
      throw unavailable(
        "export",
        "no rules pack is loaded in this session",
        "get_bom needs a rules pack too",
      );
    if (!ctx.writer)
      throw unavailable("export", "this session cannot write files", "use get_bom and copy the lines");
    const scopeText = args.scope ?? "project";
    const scope = parseBomScope(scopeText);
    if (!scope)
      throw invalidArg(
        "scope",
        `"${scopeText}" is not a scope`,
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

    const errors = [
      ...validate(p, { sizes: sizesFor(p, ctx.catalog) }),
      ...checkDesign(p, ctx.rules, { catalog: ctx.catalog }),
    ].filter((x) => x.severity === "error");
    if (errors.length > 0 && !args.force)
      throw new ToolError(
        "export.invalid",
        `the project has ${errors.length} validation error(s): ${errors
          .slice(0, 3)
          .map((e) => `${e.code} ${e.entityId ?? ""}`.trim())
          .join(", ")}`,
        errors[0]?.entityId ?? null,
        "fix them (validate lists them) or pass force: true for a file marked DRAFT",
      );
    const now = ctx.now();
    const bom = getBom(p, ctx.rules, { now, catalog: ctx.catalog, scope, explain: false });
    const flagged = bom.lines.filter((l) => l.status === "unverified" || l.status === "placeholder");
    if (flagged.length > 0 && !args.includeUnverified)
      throw new ToolError(
        "export.unverified",
        `${flagged.length} line(s) are unverified or placeholders, e.g. ${flagged
          .slice(0, 3)
          .map((l) => l.productId ?? l.description)
          .join(", ")}`,
        null,
        "verify them with verify_product, or pass includeUnverified: true for a file that highlights them",
      );
    const warnings: string[] = [];
    if (errors.length > 0) warnings.push(`exported as DRAFT over ${errors.length} validation error(s)`);
    if (flagged.length > 0)
      warnings.push(`${flagged.length} unverified or placeholder line(s) are highlighted`);
    if (bom.lines.length === 0) warnings.push("the bill of materials is empty for this scope");
    const provenance = provenanceFor(bom, p, {
      appVersion: ctx.writer.appVersion,
      exportedAt: now,
      scope: scopeText,
      validationErrors: errors.length,
      draft: errors.length > 0,
    });
    const sources = sourceLookup(p, ctx.catalog);
    const bytes =
      args.format === "csv"
        ? new TextEncoder().encode(bomToExportCsv(bom, p, provenance, sources))
        : bomToXlsx(bom, p, provenance, sources);
    const written = await ctx.writer.write(args.path, bytes, { overwrite: args.overwrite ?? false });
    for (const w of warnings) call.warn(w);
    return {
      path: written.path,
      bytes: written.bytes,
      format: args.format,
      lines: bom.lines.length,
      draft: provenance.draft,
      includesUnverified: provenance.includesUnverified,
      warnings,
    };
  },
});

interface GlbArgs {
  scope?: string | undefined;
  path: string;
  force?: boolean | undefined;
  overwrite?: boolean | undefined;
}

/** glb: the scene as the engine builds it, one node per entity (ADR-013 D4). No rules pack is needed. */
async function exportGlb(args: GlbArgs, call: ToolCall) {
  const { ctx } = call;
  if (!ctx.writer)
    throw unavailable("export", "this session cannot write files", "use render for pictures of the scene");
  const scopeText = args.scope ?? "project";
  const scope = parseBomScope(scopeText);
  if (!scope)
    throw invalidArg("scope", `"${scopeText}" is not a scope`, "use 'project', 'level:<id>' or 'room:<id>'");
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
  const sizes = sizesFor(p, ctx.catalog);
  const errors = validate(p, { sizes }).filter((x) => x.severity === "error");
  if (errors.length > 0 && !args.force)
    throw new ToolError(
      "export.invalid",
      `the project has ${errors.length} validation error(s): ${errors
        .slice(0, 3)
        .map((e) => `${e.code} ${e.entityId ?? ""}`.trim())
        .join(", ")}`,
      errors[0]?.entityId ?? null,
      "fix them (validate lists them) or pass force: true for a file marked DRAFT",
    );
  const { bytes, report } = projectToGlb(p, {
    sizes,
    appVersion: ctx.writer.appVersion,
    exportedAt: ctx.now(),
    draft: errors.length > 0,
    scope,
  });
  const written = await ctx.writer.write(args.path, bytes, { overwrite: args.overwrite ?? false });
  const warnings: string[] = [];
  if (errors.length > 0) warnings.push(`exported as DRAFT over ${errors.length} validation error(s)`);
  if (report.skippedItems.length > 0)
    warnings.push(
      `${report.skippedItems.length} item(s) have no size or are hidden and were left out: ${report.skippedItems.slice(0, 5).join(", ")}`,
    );
  if (report.nodes <= 1) warnings.push("the scene is empty for this scope");
  for (const w of warnings) call.warn(w);
  return {
    path: written.path,
    bytes: written.bytes,
    format: "glb",
    lines: 0,
    nodes: report.nodes,
    triangles: report.triangles,
    draft: errors.length > 0,
    includesUnverified: false,
    warnings,
  };
}
