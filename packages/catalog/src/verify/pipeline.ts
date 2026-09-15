// The verification pipeline (ADR-008 D3): normalise, local hit, search, fetch, extract, score, persist.
// Every dependency is an interface so the same code runs with a web search API and a local model in the
// product, with pages chosen by the calling agent during development, and with fixtures in tests.
import type { Category, Price, Product, ProductSnapshot } from "../schema.js";
import { CATEGORIES, isOpeningCategory, snapshotOf } from "../schema.js";
import { slug } from "../search.js";
import { canonicalMake, isManufacturerUrl, makeDomains } from "./makes.js";
import { ProductProposal, type ProductProposalInput } from "./proposal.js";
import { type EvidencePage, type Score, scoreProposal } from "./score.js";
import { htmlToText, mentionsModel, relevantExcerpt } from "./text.js";
import type { PageFetcher, SearchHit, SearchProvider } from "./web.js";

export interface VerifyRequest {
  make: string;
  model: string;
  category?: string | null;
  /** Page URLs to read instead of searching (an agent with its own search, or a person). */
  sources?: readonly string[];
  /** A proposal the caller already extracted from `sources`; it is still checked against the fetched pages. */
  proposal?: ProductProposalInput | null;
  /** Re-verify even when the catalog already holds a current verified record. */
  force?: boolean;
}

export interface ExtractInput {
  make: string;
  model: string;
  category: string | null;
  pages: EvidencePage[];
  signal?: AbortSignal;
}

/** The verifier model's role (ADR-007 D3): read pages, return a proposal or null. */
export interface ProposalExtractor {
  readonly id: string;
  extract(input: ExtractInput): Promise<ProductProposal | null>;
}

export interface VerificationRun {
  id: string;
  productId: string | null;
  make: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  provider: string;
  queries: string[];
  pagesFetched: string[];
  proposal: ProductProposal | null;
  score: number;
  outcome: VerifyStatus;
  notes: string[];
}

/** What the pipeline needs from the catalog; CatalogStore implements it. */
export interface VerifyStore {
  get(id: string): Product | null;
  findByMakeModel(make: string, model: string): Product | null;
  /** Insert a new product or apply verified fields to an existing one; returns the product id. */
  saveVerified(product: Product, now: string): string;
  recordRun(run: VerificationRun): void;
}

export interface VerifyDeps {
  store: VerifyStore;
  search: SearchProvider | null;
  fetcher: PageFetcher | null;
  extractor: ProposalExtractor | null;
  now(): string;
  newRunId(): string;
  /** Pages fetched per attempt (ADR-008 D3: up to three). */
  maxPages?: number;
  priceTtlDays?: number;
}

export type VerifyStatus = "verified" | "unverified" | "rejected" | "manual";

export interface VerifyOutcome {
  productId: string | null;
  status: VerifyStatus;
  confidence: number;
  product: ProductSnapshot | null;
  sources: string[];
  notes: string[];
  /** True when the catalog answered without searching. */
  cached: boolean;
  runId: string | null;
  checks: Score["checks"] | null;
  /** What was read from the pages, verified or not, so a caller can see what was found. */
  proposal: ProductProposal | null;
}

/** The pipeline cannot run with what it was given; the message completes "unavailable because ...". */
export class VerifyUnavailable extends Error {
  constructor(
    readonly because: string,
    readonly hint: string | null,
  ) {
    super(because);
    this.name = "VerifyUnavailable";
  }
}

export class VerifyInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = "VerifyInputError";
  }
}

export const DEFAULT_MAX_PAGES = 3;
export const PRICE_TTL_DAYS = 90;
const MAX_SOURCES = 5;

const DEFAULT_MOUNTS: Readonly<Partial<Record<Category, Product["mount"]["kinds"]>>> = {
  display: ["wall", "floor"],
  "video-bar": ["wall", "table"],
  camera: ["wall", "table"],
  "ceiling-mic": ["ceiling"],
  "ceiling-speaker": ["ceiling"],
  "table-mic": ["table"],
  "touch-panel": ["table"],
  scheduler: ["wall"],
  whiteboard: ["wall"],
  lighting: ["ceiling"],
};

function asCategory(c: string | null | undefined): Category | null {
  return c && (CATEGORIES as readonly string[]).includes(c) ? (c as Category) : null;
}

function snapshotFor(store: VerifyStore, id: string | null, now: string): ProductSnapshot | null {
  if (!id) return null;
  const p = store.get(id);
  return p ? snapshotOf(p, now) : null;
}

function cachedOutcome(p: Product, now: string, note: string): VerifyOutcome {
  return {
    productId: p.id,
    status: p.verification.status,
    confidence: p.verification.confidence,
    product: snapshotOf(p, now),
    sources: p.verification.sources,
    notes: [note],
    cached: true,
    runId: null,
    checks: null,
    proposal: null,
  };
}

function priceCurrent(p: Product, now: string): boolean {
  return p.price === null || p.price.expiresAt > now;
}

/** Order search hits: manufacturer pages first, then the rest in rank order, one entry per URL. */
export function rankHits(hits: readonly SearchHit[], make: string): SearchHit[] {
  const seen = new Set<string>();
  const unique = hits.filter((h) => {
    const key = h.url.replace(/#.*$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [
    ...unique.filter((h) => isManufacturerUrl(h.url, make)),
    ...unique.filter((h) => !isManufacturerUrl(h.url, make)),
  ];
}

function checkUrl(u: string): string {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new VerifyInputError("sources", `not a URL: ${u}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new VerifyInputError("sources", `only http and https pages can be read: ${u}`);
  return parsed.toString();
}

function isoPlusDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

export async function verifyProduct(
  deps: VerifyDeps,
  req: VerifyRequest,
  signal?: AbortSignal,
): Promise<VerifyOutcome> {
  const startedAt = deps.now();
  const make = canonicalMake(req.make);
  const model = req.model.trim();
  if (!make) throw new VerifyInputError("make", "is empty");
  if (!model) throw new VerifyInputError("model", "is empty");
  const existing = deps.store.findByMakeModel(make, model);

  // step 7: a person's manual record is never overridden
  if (existing?.verification.status === "manual")
    return cachedOutcome(existing, startedAt, "manual record; the pipeline never overrides it");
  // step 2: local hit
  if (
    existing?.verification.status === "verified" &&
    priceCurrent(existing, startedAt) &&
    !req.force &&
    !req.proposal
  )
    return cachedOutcome(existing, startedAt, "already verified in the catalog");

  // step 3: pages to read
  const queries: string[] = [];
  let urls: string[];
  if (req.sources && req.sources.length > 0) {
    urls = [...new Set(req.sources.map(checkUrl))].slice(0, MAX_SOURCES);
  } else {
    if (!deps.search)
      throw new VerifyUnavailable(
        "no search provider is configured",
        "pass sources: the URLs of the manufacturer's product or spec page, or place a recipe from search_catalog kind 'recipe'",
      );
    const hits: SearchHit[] = [];
    const main = `${make} ${model} specifications`;
    queries.push(main);
    hits.push(...(await deps.search.search(main, { limit: 10, ...(signal ? { signal } : {}) })));
    const domain = makeDomains(make)[0];
    if (domain) {
      const site = `site:${domain} ${model}`;
      queries.push(site);
      hits.push(...(await deps.search.search(site, { limit: 5, ...(signal ? { signal } : {}) })));
    }
    urls = rankHits(hits, make)
      .map((h) => h.url)
      .slice(0, deps.maxPages ?? DEFAULT_MAX_PAGES);
  }

  const notes: string[] = [];
  const pages: EvidencePage[] = [];
  const fetched: string[] = [];
  if (urls.length > 0) {
    if (!deps.fetcher) throw new VerifyUnavailable("no page fetcher is configured", null);
    // step 4: fetch
    for (const url of urls) {
      try {
        const page = await deps.fetcher.fetch(url, signal ? { signal } : {});
        fetched.push(page.url);
        if (page.status >= 400) {
          notes.push(`${url}: HTTP ${page.status}`);
          continue;
        }
        const type = page.contentType.toLowerCase();
        if (type.includes("html") || type.includes("xml"))
          pages.push({ url: page.url, text: htmlToText(page.body) });
        else if (type.startsWith("text/") || type.includes("json"))
          pages.push({ url: page.url, text: page.body });
        else notes.push(`${url}: ${type || "unknown content"} is not read (PDF spec sheets arrive later)`);
      } catch (e) {
        notes.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else notes.push("the search returned no pages");

  // step 4 continued: the proposal, from the caller or the verifier model
  let proposal: ProductProposal | null = null;
  const anyMention = pages.some((p) => mentionsModel(p.text, model));
  if (req.proposal) {
    const parsed = ProductProposal.safeParse(req.proposal);
    if (!parsed.success)
      throw new VerifyInputError(
        "proposal",
        parsed.error.issues.map((i) => `${i.path.join(".") || "proposal"}: ${i.message}`).join("; "),
      );
    proposal = parsed.data;
  } else if (anyMention) {
    if (!deps.extractor)
      throw new VerifyUnavailable(
        "no verifier model is configured",
        "pass proposal: the product fields you read from the sources, with fieldSources naming the page of each",
      );
    const category = asCategory(req.category) ?? existing?.category ?? null;
    try {
      proposal = await deps.extractor.extract({
        make,
        model,
        category,
        pages: pages.map((p) => ({ url: p.url, text: relevantExcerpt(p.text, model) })),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      notes.push(`the verifier model failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // step 5: score
  const score = scoreProposal(proposal, pages, { make, model });
  notes.push(...score.notes);

  // step 6: persist
  let productId: string | null = null;
  const now = deps.now();
  if (score.status !== "rejected" && proposal?.found) {
    const record = buildRecord(
      existing,
      proposal,
      score,
      req,
      make,
      model,
      now,
      deps.priceTtlDays ?? PRICE_TTL_DAYS,
      notes,
    );
    if (record) {
      try {
        productId = deps.store.saveVerified(record, now);
      } catch (e) {
        notes.push(`not saved: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else if (existing && score.status === "rejected") {
    notes.push(`the catalog record ${existing.id} is kept unchanged`);
  }
  if (!productId && existing && score.status !== "rejected") productId = existing.id;

  const runId = deps.newRunId();
  const status = score.status;
  deps.store.recordRun({
    id: runId,
    productId,
    make,
    model,
    startedAt,
    finishedAt: deps.now(),
    provider: `${req.sources?.length ? "sources" : (deps.search?.id ?? "none")}+${req.proposal ? "caller" : (deps.extractor?.id ?? "none")}`,
    queries,
    pagesFetched: fetched,
    proposal,
    score: score.confidence,
    outcome: status,
    notes,
  });
  return {
    productId,
    status,
    confidence: score.confidence,
    product: snapshotFor(deps.store, productId, now),
    sources: score.sources,
    notes,
    cached: false,
    runId,
    checks: score.checks,
    proposal,
  };
}

/**
 * The record to save, or null when there is nothing safe to save. Verified outcomes overwrite dimensions,
 * weight, grounded specs, price and lifecycle; unverified outcomes create a new record from the proposal
 * (so the agent can place it, flagged) but never touch the dimensions of an existing one.
 */
function buildRecord(
  existing: Product | null,
  proposal: ProductProposal,
  score: Score,
  req: VerifyRequest,
  make: string,
  model: string,
  now: string,
  ttlDays: number,
  notes: string[],
): Product | null {
  const category = existing?.category ?? asCategory(req.category) ?? proposal.category ?? "other";
  if (isOpeningCategory(category) && !existing) {
    notes.push("doors and windows need an opening spec and are not created by verification");
    return null;
  }
  const verified = score.status === "verified";
  const verification: Product["verification"] = {
    status: score.status === "rejected" ? "unverified" : score.status,
    confidence: score.confidence,
    sources: score.sources,
    verifiedAt: verified ? now : null,
    notes: score.notes.join("; ").slice(0, 2000) || null,
  };
  if (existing && existing.verification.status === "verified" && !verified) {
    notes.push(`the verified record ${existing.id} is kept; this attempt scored ${score.confidence}`);
    return null;
  }
  if (!proposal.dims) {
    if (existing) return { ...existing, verification, updatedAt: now };
    notes.push("no dimensions, so no catalog record was created");
    return null;
  }
  if (!existing && !score.grounded.dims) {
    notes.push("the dimensions are not stated on any page, so no catalog record was created");
    return null;
  }
  if (!existing && !score.checks.plausible) {
    notes.push("implausible dimensions, so no catalog record was created");
    return null;
  }
  const dims = {
    w: Math.max(1, Math.round(proposal.dims.w)),
    d: Math.max(1, Math.round(proposal.dims.d)),
    h: Math.max(1, Math.round(proposal.dims.h)),
  };
  const price: Price | null =
    proposal.price && score.grounded.price
      ? {
          amount: proposal.price.amount,
          currency: proposal.price.currency.toUpperCase(),
          type: isManufacturerUrl(proposal.price.sourceUrl, make) ? "list" : "street",
          sourceUrl: proposal.price.sourceUrl,
          capturedAt: now,
          expiresAt: isoPlusDays(now, ttlDays),
        }
      : null;
  const vesa = proposal.mount?.vesa ?? existing?.mount.vesa ?? null;
  let kinds = existing?.mount.kinds ?? proposal.mount?.kinds ?? DEFAULT_MOUNTS[category] ?? ["floor"];
  if (vesa && !kinds.includes("wall")) kinds = ["wall", ...kinds];
  if (existing) {
    if (!verified) return { ...existing, verification, updatedAt: now };
    return {
      ...existing,
      dims,
      weightKg: score.grounded.weightKg ? proposal.weightKg : existing.weightKg,
      mount: { ...existing.mount, kinds, vesa },
      specs: { ...existing.specs, ...score.grounded.specs },
      price: price ?? existing.price,
      verification,
      lifecycle: proposal.lifecycle === "unknown" ? existing.lifecycle : proposal.lifecycle,
      updatedAt: now,
    };
  }
  return {
    id: slug(make, model),
    make,
    model: proposal.model || model,
    variant: null,
    name: proposal.name ?? `${make} ${model}`,
    category,
    dims,
    weightKg: score.grounded.weightKg ? proposal.weightKg : null,
    mount: { kinds, vesa, defaultHeight: null },
    mountPoints: [],
    clearance: null,
    deformable: false,
    meshRotation: null,
    assetKey: null,
    materialSlots: [],
    presets: [],
    opening: null,
    specs: score.grounded.specs,
    price,
    verification,
    lifecycle: proposal.lifecycle,
    tags: [category],
    aliases: [],
    createdAt: now,
    updatedAt: now,
  };
}
