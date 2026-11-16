// What a tool runs against: the store, the catalog, and optional services (ADR-005 D1, ADR-006 D2).
// Everything here is an in-process object; nothing is a network client.

import type { PageFetcher, RulesPack, SearchProvider, VerifyOutcome, VerifyRequest } from "@fpv/catalog";
import type { Origin, Store } from "@fpv/commands";
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
  /** A texture record, for a project's texture snapshots (spec 02 section 2). */
  texture?(id: string): object | null;
  /** Every texture the catalog has, for the editor's pickers. */
  textures?(): readonly object[];
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

/** A file somebody attached to a message for the agent. */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/**
 * The files attached to the conversation, by id.
 *
 * A model names an id and never carries the bytes: an image inside a tool call would be echoed back
 * through the conversation on every turn, which is how a context window is spent on something the
 * host already has.
 */
export interface AttachmentStore {
  get(id: string): Attachment | null;
  list(): readonly { id: string; name: string; mime: string; size: number }[];
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
  /** Whether the file on disk no longer matches the manifest hash; absent when the host cannot tell. */
  readonly modifiedOutside?: boolean;
  /**
   * Stop pointing at the open project's directory, because there is no longer a project there to point
   * at: `project new` replaces the whole document, and what is now open has never been saved anywhere.
   *
   * Without this a new project inherits the previous one's path, and the next save writes a blank
   * project over it without asking. That is exactly what happened the first time File > New was
   * wired up to a Save shortcut.
   */
  forget?(): void;
  /**
   * Called when what is open, or whether it is saved, changes — an open, a save, a recovery file
   * written. The viewer bridge uses it to tell connected tabs, because none of these move the store's
   * history and so none of them appear in the change stream. Optional: a session without files, or one
   * whose files nobody is watching, works exactly as before.
   */
  watch?(listener: () => void): () => void;
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
  /** Who asked: the editor, the agent, an import. Absent in entries recorded before this was carried. */
  origin?: Origin;
}

/** Every tool call is recorded for cross-provider replay (ADR-007 D4). */
export interface TranscriptRecorder {
  record(entry: TranscriptEntry): void;
}

/**
 * A run of a second role, asked for by the model through a tool (ADR-022 D1).
 *
 * Declared here and implemented in `@fpv/agents`, injected by the host, because a tool may not
 * import the agent runner and a sub-run is a run of that runner. It is the same seam Cascade uses
 * for the same reason.
 */
export interface SubagentRequest {
  role: "architect";
  /** What to design, in the person's words. */
  brief: string;
  /** Anything already agreed with the person, so a sub-run inherits the parent's consent. */
  released?: readonly string[];
  /**
   * A design to continue from, with the errors it still has: an earlier architect's closest
   * attempt. The architect fixes it rather than starting again (ADR-028 D10).
   */
  from?: { designId: string; errors: readonly string[] };
}

export interface SubagentResult {
  /** The design it settled on, ready for build_design; null when it did not reach one. */
  designId: string | null;
  /** Its own account of what it did. All that returns to the parent: the rest stays in its context. */
  text: string;
  /** Errors the checker still reported when the round budget ran out, for an honest answer. */
  unresolved: string[];
  /** The last design it checked, passed or not, so a next architect can continue from it. */
  lastDesignId: string | null;
  /**
   * Whether the design it answers with was looked at before it was handed on: previewed by a model
   * that can see, its walk read by one that cannot (ADR-028 D11). Absent from callers that predate it.
   */
  looked?: boolean;
  /** The LOOK verdict it wrote, when it wrote one. */
  verdict?: string | null;
  /** What ended the sub-run, when something other than an answer did. */
  error?: string | null;
  steps: number;
  rounds: number;
  reason: string;
}

export interface SubagentRunner {
  run(request: SubagentRequest): Promise<SubagentResult>;
}

/**
 * The web, when the host has a search provider configured: the same search and the same guarded
 * fetcher the product verifier uses. Without it the web tools are not advertised and refuse if called.
 */
export interface WebAccess {
  search: SearchProvider;
  fetcher: PageFetcher;
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
  /** Files attached to the agent's conversation; absent in a session nobody is talking to. */
  attachments?: AttachmentStore | null;
  /** Search and a guarded fetcher (ADR-027 D4); absent or null when the host has no search provider. */
  web?: WebAccess | null;
  transcript: TranscriptRecorder | null;
  /** Runs another role in its own context; absent in a session with no agent behind it. */
  subagent?: SubagentRunner | null;
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
  hit("recipe:bed:1500x2000x900", "Double bed 1500 x 2000", "bed", {
    kind: "bed",
    size: { w: 1500, d: 2000, h: 900 },
  }),
  hit("recipe:bed:900x2000x900", "Single bed 900 x 2000", "bed", {
    kind: "bed",
    size: { w: 900, d: 2000, h: 900 },
  }),
  hit("recipe:sofa:2000x900x850", "Three-seat sofa 2000", "sofa", {
    kind: "sofa",
    size: { w: 2000, d: 900, h: 850 },
  }),
  hit("recipe:box:1800x600x2100", "Wardrobe 1800 x 600 x 2100", "wardrobe", {
    kind: "box",
    size: { w: 1800, d: 600, h: 2100 },
    label: "Wardrobe",
  }),
  hit("recipe:box:2400x600x900", "Kitchen run 2400 x 600 (worktop with units under)", "kitchen-run", {
    kind: "box",
    size: { w: 2400, d: 600, h: 900 },
    label: "Kitchen run",
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
export function memoryCatalog(
  products: readonly CatalogProduct[] = [],
  textures: readonly { id: string }[] = [],
): CatalogSearch {
  const byId = new Map(products.map((p) => [p.id, p]));
  const textureById = new Map(textures.map((t) => [t.id, t]));
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
    texture(id) {
      return textureById.get(id) ?? null;
    },
    textures() {
      return textures;
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
    texture(textureId: string): Record<string, unknown> | null {
      const t = catalog.texture?.(textureId);
      return t ? { ...t } : null;
    },
  };
}
