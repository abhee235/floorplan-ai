// The catalog store (spec 02 section 5, ADR-008 D4, D5): SQLite through Node's built-in binding, one
// file in the user's data directory, product JSON in a column with indexed columns for search, an FTS5
// table for ranking, and libraries whose highest installed version wins product clashes.
import { DatabaseSync } from "node:sqlite";
import { type AssetEntry, AssetManifest, resolveAssetKey, validateManifest } from "@fpv/assets";
import type { Size3 } from "@fpv/ir";
import {
  LibraryManifest,
  type LibraryManifestInput,
  Product,
  type ProductInput,
  type ProductSnapshot,
  type SpecValue,
  snapshotOf,
  Texture,
  type TextureInput,
} from "./schema.js";
import {
  decodeCursor,
  encodeCursor,
  expandTokens,
  ftsQuery,
  modelKey,
  normaliseText,
  SEARCH_LIMIT,
  slug,
  tokens,
} from "./search.js";
import { type CatalogProblem, hasErrors, validateProduct } from "./validate.js";
import { canonicalMake } from "./verify/makes.js";
import type { VerificationRun, VerifyStore } from "./verify/pipeline.js";

/** Fields verification may change on a library-owned product; kept apart so a library re-index never loses them. */
type Overlay = Pick<
  Product,
  "dims" | "weightKg" | "mount" | "specs" | "price" | "verification" | "lifecycle" | "updatedAt"
>;

export class CatalogError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly problems: readonly CatalogProblem[] = [],
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

export type MatchTier = "id" | "model" | "name" | "term" | "text";

export interface CatalogHit {
  id: string;
  name: string;
  make: string;
  model: string;
  category: string;
  dims: Size3;
  verified: boolean;
  price: number | null;
  status: Product["verification"]["status"];
  matchedBy: MatchTier;
}

export interface SearchQuery {
  query: string;
  category?: string | undefined;
  /** At most 20 (spec 02 section 5); default 20. */
  limit?: number | undefined;
  cursor?: string | undefined;
  includeRejected?: boolean | undefined;
}

export interface SearchResult {
  hits: CatalogHit[];
  total: number;
  cursor: string | null;
}

export interface SpecConstraint {
  gte?: number;
  lte?: number;
  eq?: SpecValue;
}

export interface CategoryConstraints {
  minDims?: Partial<Size3>;
  maxDims?: Partial<Size3>;
  specs?: Record<string, SpecConstraint>;
  verifiedOnly?: boolean;
  tags?: string[];
  activeOnly?: boolean;
}

export interface UpsertResult {
  changed: boolean;
  warnings: CatalogProblem[];
}

export interface LibraryRecord {
  id: string;
  version: string;
  name: string;
  installedAt: string;
  productCount: number;
  textureCount: number;
  assetCount: number;
}

/** A product as the tools see it: the record plus flattened status and price. */
export type ProductView = Omit<Product, "price"> & {
  status: Product["verification"]["status"];
  price: number | null;
  priceRecord: Product["price"];
};

const SCHEMA = `
create table if not exists meta(key text primary key, value text not null);
create table if not exists products(
  id text primary key, library text, make text not null, model text not null, model_key text not null,
  name text not null, hay text not null, category text not null, status text not null,
  lifecycle text not null, json text not null);
create index if not exists products_category on products(category);
create index if not exists products_model_key on products(model_key);
create index if not exists products_library on products(library);
create table if not exists product_terms(product_id text not null, term text not null, kind text not null);
create index if not exists product_terms_term on product_terms(term);
create index if not exists product_terms_product on product_terms(product_id);
create virtual table if not exists products_fts using fts5(id unindexed, name, model, make, tags, aliases, tokenize='unicode61');
create table if not exists textures(id text primary key, library text, json text not null);
create table if not exists assets(key text primary key, library text not null, version text not null, json text not null);
create table if not exists libraries(id text not null, version text not null, installed_at text not null, json text not null, primary key(id, version));
create table if not exists product_overrides(product_id text primary key, json text not null);
create table if not exists verification_runs(id text primary key, product_id text, make text not null, model_key text not null, started_at text not null, outcome text not null, json text not null);
create index if not exists verification_runs_model on verification_runs(model_key);
create index if not exists verification_runs_product on verification_runs(product_id);
`;

export const STORE_SCHEMA_VERSION = 1;

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function stripVolatile(p: Product): string {
  const { updatedAt: _u, ...rest } = p;
  return JSON.stringify(rest);
}

export class CatalogStore implements VerifyStore {
  private depth = 0;

  constructor(readonly db: DatabaseSync) {
    db.exec("pragma journal_mode = wal;");
    db.exec(SCHEMA);
    if (!this.getMeta("schemaVersion")) this.setMeta("schemaVersion", String(STORE_SCHEMA_VERSION));
  }

  /** Open (or create) the database at `path`; ":memory:" for tests and sessions without a data directory. */
  static open(path: string): CatalogStore {
    return new CatalogStore(new DatabaseSync(path));
  }

  close(): void {
    this.db.close();
  }

  // ---- meta and transactions --------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.prepare("select value from meta where key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
      )
      .run(key, value);
  }

  /** All writes run in a transaction; nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("begin immediate");
    this.depth += 1;
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    } finally {
      this.depth -= 1;
    }
  }

  // ---- products ---------------------------------------------------------------

  get(id: string): Product | null {
    const row = this.db.prepare("select json from products where id = ?").get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as Product) : null;
  }

  /** Which library owns a product: a library id, or null for a product written directly. */
  ownerOf(id: string): string | null | undefined {
    const row = this.db.prepare("select library from products where id = ?").get(id) as
      | { library: string | null }
      | undefined;
    return row ? row.library : undefined;
  }

  count(): number {
    return (this.db.prepare("select count(*) as n from products").get() as { n: number }).n;
  }

  /** Product ids in insertion-independent (alphabetical) order, for exports and tests. */
  ids(): string[] {
    return (this.db.prepare("select id from products order by id").all() as { id: string }[]).map(
      (r) => r.id,
    );
  }

  /** Every product, optionally one category, alphabetical by id. */
  all(category?: string): Product[] {
    const rows = category
      ? (this.db.prepare("select json from products where category = ? order by id").all(category) as {
          json: string;
        }[])
      : (this.db.prepare("select json from products order by id").all() as { json: string }[]);
    return rows.map((r) => JSON.parse(r.json) as Product);
  }

  /** Parse and validate; throws CatalogError("product.invalid") with the problems on any error. */
  static prepare(input: ProductInput): { product: Product; warnings: CatalogProblem[] } {
    const parsed = Product.safeParse(input);
    if (!parsed.success) {
      const id = typeof (input as { id?: unknown }).id === "string" ? (input as { id: string }).id : null;
      const problems = parsed.error.issues.map((i) => ({
        code: "product.shape",
        severity: "error" as const,
        productId: id,
        message: `${id ?? "product"}: ${i.path.join(".") || "record"}: ${i.message}`,
      }));
      throw new CatalogError("product.invalid", problems.map((p) => p.message).join("; "), problems);
    }
    const problems = validateProduct(parsed.data);
    if (hasErrors(problems))
      throw new CatalogError(
        "product.invalid",
        problems
          .filter((p) => p.severity === "error")
          .map((p) => p.message)
          .join("; "),
        problems,
      );
    return { product: parsed.data, warnings: problems };
  }

  /** Insert a new product; an existing id is an error, never a silent skip or merge (C-026 reversed). */
  insert(input: ProductInput, options: { library?: string | null; now?: string } = {}): UpsertResult {
    const id = (input as { id?: unknown }).id;
    if (typeof id === "string" && this.ownerOf(id) !== undefined)
      throw new CatalogError("product.duplicate", `${id}: a product with this id already exists`);
    return this.upsert(input, options);
  }

  /**
   * Write a product. The owner (a library id or null for direct writes) must match the existing
   * record's owner, otherwise the id clashes. An identical record is not rewritten and keeps its
   * updatedAt (O-006: no change, no event).
   */
  upsert(input: ProductInput, options: { library?: string | null; now?: string } = {}): UpsertResult {
    const owner = options.library ?? null;
    const { product, warnings } = CatalogStore.prepare(input);
    return this.transaction(() => {
      const existing = this.get(product.id);
      const existingOwner = this.ownerOf(product.id);
      if (existing && existingOwner !== owner)
        throw new CatalogError(
          "product.duplicate",
          `${product.id}: already provided by ${existingOwner === null ? "a direct write" : `library ${existingOwner}`}`,
        );
      if (existing && stripVolatile(existing) === stripVolatile(this.withOverride(product)))
        return { changed: false, warnings };
      const record: Product = {
        ...product,
        createdAt: existing?.createdAt ?? product.createdAt,
        updatedAt: options.now ?? product.updatedAt,
      };
      this.writeProduct(record, owner);
      return { changed: true, warnings };
    });
  }

  private writeProduct(base: Product, owner: string | null): void {
    const p = this.withOverride(base);
    const hay = normaliseText(`${p.name} ${p.model} ${p.make} ${p.variant ?? ""}`);
    this.db
      .prepare(
        `insert into products(id, library, make, model, model_key, name, hay, category, status, lifecycle, json)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set library = excluded.library, make = excluded.make, model = excluded.model,
           model_key = excluded.model_key, name = excluded.name, hay = excluded.hay, category = excluded.category,
           status = excluded.status, lifecycle = excluded.lifecycle, json = excluded.json`,
      )
      .run(
        p.id,
        owner,
        p.make,
        p.model,
        modelKey(p.model),
        p.name,
        hay,
        p.category,
        p.verification.status,
        p.lifecycle,
        JSON.stringify(p),
      );
    this.db.prepare("delete from product_terms where product_id = ?").run(p.id);
    const term = this.db.prepare("insert into product_terms(product_id, term, kind) values (?, ?, ?)");
    for (const t of p.tags) term.run(p.id, normaliseText(t), "tag");
    for (const a of p.aliases) term.run(p.id, normaliseText(a), "alias");
    term.run(p.id, normaliseText(p.category), "category");
    this.db.prepare("delete from products_fts where id = ?").run(p.id);
    this.db
      .prepare("insert into products_fts(id, name, model, make, tags, aliases) values (?, ?, ?, ?, ?, ?)")
      .run(p.id, p.name, p.model, p.make, p.tags.join(" "), p.aliases.join(" "));
  }

  remove(id: string): boolean {
    return this.transaction(() => {
      const r = this.db.prepare("delete from products where id = ?").run(id);
      this.db.prepare("delete from product_terms where product_id = ?").run(id);
      this.db.prepare("delete from products_fts where id = ?").run(id);
      return r.changes > 0;
    });
  }

  /** The tools' view: the record with status and price amount flattened. */
  product(id: string): ProductView | null {
    const p = this.get(id);
    return p
      ? { ...p, status: p.verification.status, price: p.price?.amount ?? null, priceRecord: p.price }
      : null;
  }

  snapshot(ids: readonly string[], snapshotAt: string): Record<string, ProductSnapshot> {
    const out: Record<string, ProductSnapshot> = {};
    for (const id of ids) {
      const p = this.get(id);
      if (p) out[id] = snapshotOf(p, snapshotAt);
    }
    return out;
  }

  // ---- search -----------------------------------------------------------------

  /**
   * Search order (spec 02 section 5): exact id, exact model, every word in name/model/make, tags and
   * aliases (with synonyms), then FTS ranking. Rejected products only answer to their exact id.
   */
  search(q: SearchQuery): SearchResult {
    const limit = Math.max(1, Math.min(q.limit ?? SEARCH_LIMIT, SEARCH_LIMIT));
    const offset = decodeCursor(q.cursor);
    const raw = q.query.trim();
    const norm = normaliseText(raw);
    const words = tokens(raw);
    const ordered: { id: string; tier: MatchTier }[] = [];
    const seen = new Set<string>();
    const add = (id: string, tier: MatchTier) => {
      if (seen.has(id)) return;
      seen.add(id);
      ordered.push({ id, tier });
    };
    const accept = (row: { category: string; status: string }) =>
      (q.includeRejected || row.status !== "rejected") && (!q.category || row.category === q.category);
    type Row = { id: string; category: string; status: string };

    // 1. exact id, as typed or as the slug of what was typed
    for (const candidate of [raw, norm, slug(raw)]) {
      const row = this.db.prepare("select id, category, status from products where id = ?").get(candidate) as
        | Row
        | undefined;
      if (row) add(row.id, "id");
    }
    if (norm.length > 0) {
      // 2. exact model number, ignoring spaces, dashes and case
      const mk = modelKey(raw);
      if (mk.length > 0)
        for (const row of this.db
          .prepare("select id, category, status from products where model_key = ? order by id")
          .all(mk) as Row[])
          if (accept(row)) add(row.id, "model");
      // 3. every word appears in name, model, make or variant
      if (words.length > 0) {
        const clauses = words.map(() => "instr(hay, ?) > 0").join(" and ");
        for (const row of this.db
          .prepare(`select id, category, status from products where ${clauses} order by id`)
          .all(...words) as Row[])
          if (accept(row)) add(row.id, "name");
      }
      // 4. tags and aliases, with the synonym table, whole query first then single words
      const terms = expandTokens([norm, ...words]);
      const marks = terms.map(() => "?").join(", ");
      for (const row of this.db
        .prepare(
          `select distinct p.id, p.category, p.status from products p join product_terms t on t.product_id = p.id
           where t.term in (${marks}) order by p.id`,
        )
        .all(...terms) as Row[])
        if (accept(row)) add(row.id, "term");
      // 5. full-text ranking over name, model, make, tags and aliases
      const fts = ftsQuery(expandTokens(words));
      if (fts)
        for (const row of this.db
          .prepare(
            `select p.id, p.category, p.status from products_fts f join products p on p.id = f.id
             where products_fts match ? order by bm25(products_fts), p.id`,
          )
          .all(fts) as Row[])
          if (accept(row)) add(row.id, "text");
    } else {
      // An empty query lists the catalog, to browse it: a category's products by name when one is given,
      // otherwise everything by category and then name.
      const rows = (
        q.category
          ? this.db
              .prepare("select id, category, status from products where category = ? order by name, id")
              .all(q.category)
          : this.db.prepare("select id, category, status from products order by category, name, id").all()
      ) as Row[];
      for (const row of rows) if (accept(row)) add(row.id, "term");
    }
    const page = ordered.slice(offset, offset + limit);
    const hits = page.map(({ id, tier }) => this.hitOf(this.get(id) as Product, tier));
    const next = offset + limit < ordered.length ? encodeCursor(offset + limit) : null;
    return { hits, total: ordered.length, cursor: next };
  }

  private hitOf(p: Product, matchedBy: MatchTier): CatalogHit {
    return {
      id: p.id,
      name: p.name,
      make: p.make,
      model: p.model,
      category: p.category,
      dims: p.dims,
      verified: p.verification.status === "verified" || p.verification.status === "manual",
      price: p.price?.amount ?? null,
      status: p.verification.status,
      matchedBy,
    };
  }

  /** Products of one category meeting size, spec, tag and status constraints, alphabetical by name. */
  byCategory(category: string, c: CategoryConstraints = {}): Product[] {
    const specOk = (p: Product) => {
      for (const [key, rule] of Object.entries(c.specs ?? {})) {
        const v = p.specs[key];
        if (v === undefined) return false;
        if (rule.eq !== undefined && v !== rule.eq) return false;
        if (rule.gte !== undefined && !(typeof v === "number" && v >= rule.gte)) return false;
        if (rule.lte !== undefined && !(typeof v === "number" && v <= rule.lte)) return false;
      }
      return true;
    };
    const dimsOk = (p: Product) => {
      for (const k of ["w", "d", "h"] as const) {
        const min = c.minDims?.[k];
        const max = c.maxDims?.[k];
        if (min !== undefined && p.dims[k] < min) return false;
        if (max !== undefined && p.dims[k] > max) return false;
      }
      return true;
    };
    const tags = (c.tags ?? []).map(normaliseText);
    return this.all(category)
      .filter(
        (p) =>
          p.verification.status !== "rejected" &&
          (!c.verifiedOnly || p.verification.status === "verified" || p.verification.status === "manual") &&
          (!c.activeOnly || p.lifecycle !== "discontinued") &&
          dimsOk(p) &&
          specOk(p) &&
          tags.every((t) => p.tags.map(normaliseText).includes(t)),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  // ---- verification (ADR-008 D3, spec 02 section 6) ------------------------------

  private overlayOf(id: string): Overlay | null {
    const row = this.db.prepare("select json from product_overrides where product_id = ?").get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as Overlay) : null;
  }

  /** A library record with any verified fields applied on top; specs merge, the rest replace. */
  private withOverride(p: Product): Product {
    const o = this.overlayOf(p.id);
    if (!o) return p;
    return { ...p, ...o, specs: { ...p.specs, ...o.specs }, createdAt: p.createdAt };
  }

  /** The catalog record for a make and model: model number compared without spaces or dashes, make by canonical spelling. */
  findByMakeModel(make: string, model: string): Product | null {
    const rows = this.db
      .prepare("select json from products where model_key = ? order by id")
      .all(modelKey(model)) as {
      json: string;
    }[];
    const want = canonicalMake(make).toLowerCase();
    for (const r of rows) {
      const p = JSON.parse(r.json) as Product;
      if (canonicalMake(p.make).toLowerCase() === want) return p;
    }
    return null;
  }

  /**
   * Save a verification result. A product a library provides keeps its library record and gains an
   * overlay (so a later library version does not erase verified data); any other product is written
   * directly. The record is validated either way. Returns the product id.
   */
  saveVerified(product: Product, now: string): string {
    const { product: checked } = CatalogStore.prepare(product);
    return this.transaction(() => {
      const owner = this.ownerOf(checked.id);
      if (typeof owner === "string") {
        const overlay: Overlay = {
          dims: checked.dims,
          weightKg: checked.weightKg,
          mount: checked.mount,
          specs: checked.specs,
          price: checked.price,
          verification: checked.verification,
          lifecycle: checked.lifecycle,
          updatedAt: now,
        };
        this.db
          .prepare(
            "insert into product_overrides(product_id, json) values (?, ?) on conflict(product_id) do update set json = excluded.json",
          )
          .run(checked.id, JSON.stringify(overlay));
        this.writeProduct(this.get(checked.id) as Product, owner);
      } else this.upsert(checked, { library: null, now });
      return checked.id;
    });
  }

  recordRun(run: VerificationRun): void {
    this.db
      .prepare(
        "insert into verification_runs(id, product_id, make, model_key, started_at, outcome, json) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.id,
        run.productId,
        run.make,
        modelKey(run.model),
        run.startedAt,
        run.outcome,
        JSON.stringify(run),
      );
  }

  /** Verification attempts, newest first, for one product id or one model number. */
  runs(filter: { productId?: string; model?: string } = {}): VerificationRun[] {
    const rows = filter.productId
      ? this.db
          .prepare(
            "select json from verification_runs where product_id = ? order by started_at desc, id desc",
          )
          .all(filter.productId)
      : filter.model
        ? this.db
            .prepare(
              "select json from verification_runs where model_key = ? order by started_at desc, id desc",
            )
            .all(modelKey(filter.model))
        : this.db.prepare("select json from verification_runs order by started_at desc, id desc").all();
    return (rows as { json: string }[]).map((r) => JSON.parse(r.json) as VerificationRun);
  }

  // ---- textures ---------------------------------------------------------------

  getTexture(id: string): Texture | null {
    const row = this.db.prepare("select json from textures where id = ?").get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as Texture) : null;
  }

  upsertTexture(input: TextureInput, options: { library?: string | null } = {}): Texture {
    const t = Texture.parse(input);
    this.db
      .prepare(
        "insert into textures(id, library, json) values (?, ?, ?) on conflict(id) do update set library = excluded.library, json = excluded.json",
      )
      .run(t.id, options.library ?? null, JSON.stringify(t));
    return t;
  }

  removeTexture(id: string): boolean {
    return this.db.prepare("delete from textures where id = ?").run(id).changes > 0;
  }

  textures(): Texture[] {
    return (this.db.prepare("select json from textures order by id").all() as { json: string }[]).map(
      (r) => JSON.parse(r.json) as Texture,
    );
  }

  // ---- assets -----------------------------------------------------------------

  assetEntries(): AssetEntry[] {
    return (this.db.prepare("select json from assets order by key").all() as { json: string }[]).map(
      (r) => JSON.parse(r.json) as AssetEntry,
    );
  }

  assetEntry(key: string): AssetEntry | null {
    const row = this.db.prepare("select json from assets where key = ?").get(key) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as AssetEntry) : null;
  }

  /** The asset key a product draws with (spec 02 section 3.1), considering installed packs and built-ins. */
  resolveAssetKey(product: Pick<Product, "category" | "dims" | "assetKey">): string {
    return resolveAssetKey(product, this.assetEntries());
  }

  // ---- libraries --------------------------------------------------------------

  libraries(): LibraryRecord[] {
    return (
      this.db
        .prepare(
          "select id, version, installed_at, json from libraries order by installed_at desc, id, version",
        )
        .all() as {
        id: string;
        version: string;
        installed_at: string;
        json: string;
      }[]
    ).map((r) => {
      const m = JSON.parse(r.json) as LibraryManifest;
      return {
        id: r.id,
        version: r.version,
        name: m.name,
        installedAt: r.installed_at,
        productCount: m.products.length,
        textureCount: m.textures.length,
        assetCount: m.assets.entries.length,
      };
    });
  }

  library(id: string, version: string): LibraryManifest | null {
    const row = this.db.prepare("select json from libraries where id = ? and version = ?").get(id, version) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as LibraryManifest) : null;
  }

  /**
   * Install a library manifest (spec 02 section 4): validated whole, stored by id and version, then the
   * index is rebuilt so the highest version of each id provides its products (C-027). Any product id
   * already provided by another owner fails the install (C-026 reversed).
   */
  installLibrary(input: LibraryManifestInput, now: string): LibraryRecord {
    const parsed = LibraryManifest.safeParse(input);
    if (!parsed.success)
      throw new CatalogError(
        "library.invalid",
        parsed.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; "),
      );
    const m = parsed.data;
    const manifestProblems = validateManifest(m.assets);
    if (manifestProblems.length > 0)
      throw new CatalogError("library.invalid", manifestProblems.map((p) => p.message).join("; "));
    const seen = new Set<string>();
    for (const p of m.products) {
      if (seen.has(p.id))
        throw new CatalogError("product.duplicate", `${m.id}: duplicate product id ${p.id}`);
      seen.add(p.id);
      CatalogStore.prepare(p);
    }
    for (const t of m.textures)
      if (!t.id.startsWith(`${m.id}/`))
        throw new CatalogError("library.invalid", `${m.id}: texture ${t.id} must be named <library>/<slug>`);
    return this.transaction(() => {
      this.db
        .prepare(
          "insert into libraries(id, version, installed_at, json) values (?, ?, ?, ?) on conflict(id, version) do update set installed_at = excluded.installed_at, json = excluded.json",
        )
        .run(m.id, m.version, now, JSON.stringify(m));
      this.reindex(now);
      return this.libraries().find((l) => l.id === m.id && l.version === m.version) as LibraryRecord;
    });
  }

  uninstallLibrary(id: string, version: string, now: string): boolean {
    return this.transaction(() => {
      const r = this.db.prepare("delete from libraries where id = ? and version = ?").run(id, version);
      if (r.changes === 0) return false;
      this.reindex(now);
      return true;
    });
  }

  /** Rebuild library-owned products, textures and assets from the highest installed version of each id. */
  private reindex(now: string): void {
    const rows = this.db.prepare("select id, version, json from libraries").all() as {
      id: string;
      version: string;
      json: string;
    }[];
    const winners = new Map<string, LibraryManifest>();
    for (const r of rows) {
      const current = winners.get(r.id);
      if (!current || compareVersions(r.version, current.version) > 0)
        winners.set(r.id, JSON.parse(r.json) as LibraryManifest);
    }
    // products: remove what libraries no longer provide, then write the winners
    const wanted = new Map<string, { owner: string; product: Product }>();
    for (const m of winners.values())
      for (const p of m.products) {
        const other = wanted.get(p.id);
        if (other && other.owner !== m.id)
          throw new CatalogError(
            "product.duplicate",
            `${p.id}: already provided by library ${other.owner}; ${m.id} cannot provide it too`,
          );
        wanted.set(p.id, { owner: m.id, product: p });
      }
    for (const row of this.db.prepare("select id, library from products where library is not null").all() as {
      id: string;
      library: string;
    }[])
      if (wanted.get(row.id)?.owner !== row.library) this.remove(row.id);
    for (const { owner, product } of wanted.values()) this.upsert(product, { library: owner, now });
    // textures and assets belong wholly to their library
    this.db.prepare("delete from textures where library is not null").run();
    this.db.prepare("delete from assets").run();
    const asset = this.db.prepare("insert into assets(key, library, version, json) values (?, ?, ?, ?)");
    for (const m of winners.values()) {
      for (const t of m.textures) this.upsertTexture(t, { library: m.id });
      for (const e of AssetManifest.parse(m.assets).entries) {
        const clash = this.assetEntry(e.key);
        if (clash)
          throw new CatalogError("asset.duplicate", `${m.id}: asset key ${e.key} is already provided`);
        asset.run(e.key, m.id, m.version, JSON.stringify(e));
      }
    }
  }

  // ---- interchange --------------------------------------------------------------

  /** Directly written products as a library manifest, for sharing between machines (ADR-008 D5). */
  exportDirect(id: string, name: string, version: string, licenceAuthor: string | null): LibraryManifest {
    const products = (
      this.db.prepare("select json from products where library is null order by id").all() as {
        json: string;
      }[]
    ).map((r) => JSON.parse(r.json) as Product);
    return LibraryManifest.parse({
      id,
      name,
      version,
      licence: { id: "own", author: licenceAuthor, sourceUrl: null, attribution: null },
      provider: null,
      products,
      textures: this.textures().filter((t) => t.id.startsWith(`${id}/`)),
      assets: { version: 1, entries: [] },
      localized: {},
    });
  }
}
