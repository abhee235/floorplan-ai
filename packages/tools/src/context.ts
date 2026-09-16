// What a tool runs against: the store, the catalog, and optional services (ADR-005 D1, ADR-006 D2).
// Everything here is an in-process object; nothing is a network client.

import type { RulesPack, VerifyOutcome, VerifyRequest } from "@fpv/catalog";
import type { Store } from "@fpv/commands";
import type { PlanDraft, PlanPreview } from "@fpv/importers";
import type { PrimitiveRecipe, Project, Size3 } from "@fpv/ir";
import { derive } from "@fpv/ir";

export interface CatalogHit {
  id: string;
  name: string;
  make: string;
  model: string;
  category: string;
  dims: Size3;
  verified: boolean;
  price: number | null;
  /** Present for recipe hits: pass it to place_item as `recipe`. */
  recipe?: PrimitiveRecipe;
}

/** A product as the catalog knows it; extra fields ride along into the project's snapshot. */
export interface CatalogProduct {
  id: string;
  make: string;
  model: string;
  name: string;
  category: string;
  dims: Size3;
  status: "verified" | "unverified" | "rejected" | "manual";
  deformable?: boolean;
  price?: number | null;
  tags?: string[];
  [extra: string]: unknown;
}

export interface CatalogSearch {
  search(q: { query: string; category?: string; limit: number; cursor?: string }): {
    hits: CatalogHit[];
    total: number;
    cursor?: string | null;
  };
  product(id: string): CatalogProduct | null;
  /** Every product of a category, for BOM rules that add a product by constraint (ADR-009 D4). */
  byCategory?(category: string): readonly unknown[];
  /** The strict snapshot for a project's catalogRefs, when the catalog can make one (spec 02 section 1.1). */
  snapshot?(ids: readonly string[], snapshotAt: string): Record<string, Record<string, unknown>>;
}

export interface RenderRequest {
  view: "plan" | "overhead" | "room" | "eye";
  focusId?: string;
  hideWalls?: boolean;
  width?: number;
}
export interface RenderedImage {
  name: string;
  width: number;
  height: number;
  pngBase64: string;
}
/** The connected viewer, when there is one (ADR-005 D6). */
export interface ViewerRenderer {
  render(req: RenderRequest): Promise<{ images: RenderedImage[] }>;
  /** Show a draft under review in connected viewers, or clear it with null (ADR-011 D5). */
  presentDraft?(presentation: DraftPresentation | null): void;
}

/** What a viewer needs to review a draft: the draft, the source line work, and the reader's report. */
export interface DraftPresentation {
  draftId: string;
  draft: PlanDraft;
  preview: PlanPreview | null;
  /** The source image of a raster draft, drawn under it in the review. */
  image: PlanImage | null;
  warnings: string[];
}

export interface PlanImage {
  dataUrl: string;
  width: number;
  height: number;
}

/** What a plan reader returns: the draft, what it could not read, and what the review draws underneath. */
export interface PlanReadOutcome {
  draft: PlanDraft;
  report: { warnings: string[]; skipped: Record<string, number> };
  preview: PlanPreview | null;
  image: PlanImage | null;
  fileName: string;
}

export interface PlanReadRequest {
  /** A file path the host can read; relative paths resolve against the host's working directory. */
  path?: string;
  /** The file's text, when the caller has it (the app's file picker). */
  content?: string;
  /** The file's bytes in base64, for images from the app's file picker. */
  contentBase64?: string;
  /** Names the content's format, e.g. "plan.dxf" or "level1.png". */
  fileName?: string;
  page?: number;
}

/** Reads plan files into drafts (ADR-011 D2); supplied by the host. Throws ToolError. */
export interface PlanReader {
  read(req: PlanReadRequest): Promise<PlanReadOutcome>;
}

export interface OpenOptions {
  /** Load the newer recovery file instead of project.json (ADR-012 D6). */
  recover?: boolean;
}

export interface OpenInfo {
  project: Project;
  /** The project directory. */
  path: string;
  migrated: boolean;
  /** The manifest hash did not match: the file was edited outside the app (never blocks opening). */
  modifiedOutside: boolean;
  manifestMissing: boolean;
  /** ISO time of a recovery file newer than the saved file, or null. */
  recoveryAt: string | null;
}

/** Project file operations supplied by the host (ADR-012); null in a session without files. */
export interface ProjectFiles {
  path(): string | null;
  lastSavedAt(): string | null;
  recoveryAt(): string | null;
  open(path: string, options?: OpenOptions): Promise<OpenInfo>;
  save(path: string | null, options?: { signal?: AbortSignal }): Promise<{ path: string; bytes: number }>;
}

/**
 * Product verification supplied by the host (ADR-008 D3): the catalog pipeline with whatever search
 * provider, page fetcher and verifier model this installation has. Null in a session without a catalog.
 */
export interface ProductVerifier {
  verify(req: VerifyRequest): Promise<VerifyOutcome>;
}

/** Writes export files for the export tool (ADR-013); the host resolves paths and writes atomically. */
export interface ExportWriter {
  readonly appVersion: string;
  write(
    path: string,
    bytes: Uint8Array,
    options: { overwrite: boolean },
  ): Promise<{ path: string; bytes: number }>;
}

export interface TranscriptEntry {
  seq: number;
  tool: string;
  args: unknown;
  result: unknown;
  at: string;
  durationMs: number;
}

/** Every tool call is recorded for cross-provider replay (ADR-007 D4). */
export interface TranscriptRecorder {
  record(entry: TranscriptEntry): void;
}

export interface ToolContext {
  store: Store;
  catalog: CatalogSearch;
  viewer: ViewerRenderer | null;
  files: ProjectFiles | null;
  verifier: ProductVerifier | null;
  /** The rules pack for get_bom and design checks (spec 07); null in a session without one. */
  rules: RulesPack | null;
  /** Where exports are written; null in a session that cannot write files. */
  writer: ExportWriter | null;
  /** Reads plan files for import_plan; absent or null in a session without one. */
  plans?: PlanReader | null;
  transcript: TranscriptRecorder | null;
  now(): string;
}

/** Size source that prefers the project's own snapshots and falls back to the live catalog. */
export function sizesFor(project: Project, catalog: CatalogSearch): derive.SizeSource {
  const snapshots = derive.snapshotSizeSource(project);
  return {
    product(id) {
      const s = snapshots.product(id);
      if (s) return s;
      const p = catalog.product(id);
      return p
        ? {
            dims: p.dims,
            deformable: p.deformable ?? false,
            category: p.category,
            assetKey: typeof p.assetKey === "string" ? p.assetKey : null,
          }
        : null;
    },
  };
}

// ---- built-in catalog ------------------------------------------------------

/** Parametric recipes a model can place without any product (spec 02 section 3). */
export const RECIPE_TEMPLATES: readonly CatalogHit[] = [
  hit("recipe:table:rect:2400x1200x750", "Rectangular meeting table 2400 x 1200", "table", {
    kind: "table",
    size: { w: 2400, d: 1200, h: 750 },
    shape: "rect",
  }),
  hit("recipe:table:boat:3600x1400x750", "Boat-shaped boardroom table 3600 x 1400", "table", {
    kind: "table",
    size: { w: 3600, d: 1400, h: 750 },
    shape: "boat",
  }),
  hit("recipe:table:round:1200x1200x750", "Round huddle table 1200", "table", {
    kind: "table",
    size: { w: 1200, d: 1200, h: 750 },
    shape: "round",
  }),
  hit("recipe:chair:600x600x900", "Task chair", "chair", { kind: "chair", size: { w: 600, d: 600, h: 900 } }),
  hit("recipe:display:75", "75 inch display", "display", { kind: "display", diagonalIn: 75, bezelMm: 15 }),
  hit("recipe:display:85", "85 inch display", "display", { kind: "display", diagonalIn: 85, bezelMm: 15 }),
  hit("recipe:display:98", "98 inch display", "display", { kind: "display", diagonalIn: 98, bezelMm: 15 }),
  hit("recipe:video-bar:1200x100x100", "Video bar", "video-bar", {
    kind: "video-bar",
    size: { w: 1200, d: 100, h: 100 },
  }),
  hit("recipe:ceiling-speaker:200", "Ceiling speaker 200", "ceiling-speaker", {
    kind: "ceiling-speaker",
    diameter: 200,
  }),
  hit("recipe:ceiling-mic:600x600x50", "Ceiling microphone array 600", "ceiling-mic", {
    kind: "ceiling-mic",
    size: { w: 600, d: 600, h: 50 },
  }),
  hit("recipe:box:600x400x500", "Generic box 600 x 400 x 500 (credenza, cabinet, unit)", "box", {
    kind: "box",
    size: { w: 600, d: 400, h: 500 },
    label: "box",
  }),
  hit("recipe:cylinder:300x400", "Generic cylinder 300 x 400 (bin, stool)", "cylinder", {
    kind: "cylinder",
    diameter: 300,
    height: 400,
    label: "cylinder",
  }),
];

function hit(id: string, name: string, category: string, recipe: PrimitiveRecipe): CatalogHit {
  return {
    id,
    name,
    make: "recipe",
    model: id,
    category,
    dims: derive.recipeSize(recipe),
    verified: true,
    price: null,
    recipe,
  };
}

function score(text: string, terms: string[]): number {
  const t = text.toLowerCase();
  let s = 0;
  for (const term of terms) if (t.includes(term)) s += 1;
  return s;
}

/** Search recipes by words in the id, name and category; exact id first. */
export function searchRecipes(
  query: string,
  category: string | undefined,
  limit: number,
): { hits: CatalogHit[]; total: number } {
  const exact = RECIPE_TEMPLATES.find((r) => r.id === query);
  if (exact) return { hits: [exact], total: 1 };
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = RECIPE_TEMPLATES.filter((r) => !category || r.category === category)
    .map((r) => ({ r, s: terms.length === 0 ? 1 : score(`${r.id} ${r.name} ${r.category}`, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  return { hits: scored.slice(0, limit).map((x) => x.r), total: scored.length };
}

/** An in-memory catalog: enough for tests and for a session without the SQLite catalog (phase 1). */
export function memoryCatalog(products: readonly CatalogProduct[] = []): CatalogSearch {
  const byId = new Map(products.map((p) => [p.id, p]));
  const toHit = (p: CatalogProduct): CatalogHit => ({
    id: p.id,
    name: p.name,
    make: p.make,
    model: p.model,
    category: p.category,
    dims: p.dims,
    verified: p.status === "verified",
    price: p.price ?? null,
  });
  return {
    search({ query, category, limit }) {
      const exact = byId.get(query);
      if (exact) return { hits: [toHit(exact)], total: 1 };
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = products
        .filter((p) => p.status !== "rejected" && (!category || p.category === category))
        .map((p) => ({
          p,
          s:
            terms.length === 0
              ? 1
              : score(
                  `${p.id} ${p.name} ${p.make} ${p.model} ${p.category} ${(p.tags ?? []).join(" ")}`,
                  terms,
                ),
        }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.p.id.localeCompare(b.p.id));
      return { hits: scored.slice(0, limit).map((x) => toHit(x.p)), total: scored.length };
    },
    product(id) {
      return byId.get(id) ?? null;
    },
    byCategory(category) {
      return products.filter((p) => p.category === category);
    },
  };
}

/** Bridge from the tools' catalog to the commands' snapshot source (the store copies snapshots on first use). */
export function catalogSourceOf(catalog: CatalogSearch, now: () => string) {
  return {
    product(productId: string): Record<string, unknown> | null {
      if (catalog.snapshot) return catalog.snapshot([productId], now())[productId] ?? null;
      const p = catalog.product(productId);
      return p ? { ...p, snapshotAt: now() } : null;
    },
  };
}
