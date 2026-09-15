// Importer for flat "key#index=value" furniture and texture catalogs in centimetres (ADR-010 D10,
// ledger C-001..C-029, O-007..O-013, O-084..O-087). Pieces are 1-based and scanning stops at the first
// missing name (C-001); a piece marked ignored is skipped and scanning continues (C-002, C-003
// reversed: "false" is just not ignored). A missing mandatory key rejects the whole file with a named
// error rather than silently skipping it (C-005). Nothing here touches the file system.
import { parseMatrix } from "./matrix.js";
import { type Category, isOpeningCategory, type Product, type Sash } from "./schema.js";
import { slug } from "./search.js";

export interface FlatImportOptions {
  /** Library id the pieces belong to; also the make when the file names no creator. */
  libraryId: string;
  /** "user" forces the door defaults a modifiable piece always gets (O-012). */
  source: "library" | "user";
  now: string;
  /** locale -> the same file in another language; only names, categories and tags are taken (C-034, C-035). */
  localized?: Record<string, string>;
  currency?: string;
}

export interface ImportedPiece {
  product: Product;
  /** References as written, resolved per C-024; the installer turns them into assets. */
  modelFile: string;
  iconFile: string;
  planIconFile: string | null;
  /** Bytes declared by the file (C-019); null means measure the file. */
  modelBytes: number | null;
  /** Digests the file declares, carried but never trusted (C-025). */
  declaredDigests: Record<string, string>;
  localizedNames: Record<string, string>;
}

export interface ImportedTexture {
  id: string;
  name: string;
  category: string;
  imageFile: string;
  widthMm: number;
  heightMm: number;
  creator: string | null;
  declaredDigests: Record<string, string>;
  localizedNames: Record<string, string>;
}

export type FlatImportResult<T> = { ok: true; items: T[]; warnings: string[] } | { ok: false; error: string };

/** Java-style properties: `key=value` or `key: value`, `#` and `!` comments, `\` continuations, \uXXXX. */
export function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    let line = (lines[i] as string).replace(/^\s+/, "");
    i += 1;
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i < lines.length) {
      line = line.slice(0, -1) + (lines[i] as string).replace(/^\s+/, "");
      i += 1;
    }
    const m = /^((?:\\.|[^=:\s])+)\s*[=:]?\s*(.*)$/.exec(line);
    if (!m) continue;
    const unescape = (s: string) =>
      s.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, u: string | undefined, c: string | undefined) =>
        u ? String.fromCharCode(Number.parseInt(u, 16)) : c === "n" ? "\n" : c === "t" ? "\t" : (c ?? ""),
      );
    out.set(unescape(m[1] as string), unescape((m[2] as string).trim()));
  }
  return out;
}

const REQUIRED_PIECE_KEYS = [
  "name",
  "category",
  "icon",
  "model",
  "width",
  "depth",
  "height",
  "movable",
  "doorOrWindow",
];
const REQUIRED_TEXTURE_KEYS = ["name", "category", "image", "width", "height"];

/** Category words, first match wins; checked against the piece's own category text then its name. */
const CATEGORY_WORDS: readonly [RegExp, Category][] = [
  [/\bwindow/i, "window"],
  [/\bdoor/i, "door"],
  [/\b(sofa|couch|settee|loveseat)/i, "sofa"],
  [/\b(chair|stool|seat|armchair)/i, "chair"],
  [/\bdesk/i, "desk"],
  [/\btable/i, "table"],
  [/\b(shel|cabinet|cupboard|storage|wardrobe|bookcase|drawer|chest|credenza|locker)/i, "storage"],
  [/\b(light|lamp|chandelier)/i, "lighting"],
  [/\b(tv|television|screen|display|monitor)/i, "display"],
  [/\bwhiteboard/i, "whiteboard"],
  [/\bpartition/i, "partition"],
  [/\b(plant|tree|flower)/i, "plant"],
  [/\b(fridge|oven|dishwasher|washer|appliance|kitchen|bathroom|sink|toilet|shower|bath)/i, "appliance"],
];

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v.trim().toLowerCase() === "true"; // anything else is false, like the source format
}

function cmToMm(cm: number): number {
  return Math.round(cm * 10);
}

function numberOf(key: string, v: string): number {
  const n = Number(v.trim());
  if (v.trim() === "" || !Number.isFinite(n)) throw new Error(`${key}: not a number: ${v}`);
  return n;
}

function list(v: string): string[] {
  return v.trim().split(/\s+/).filter(Boolean);
}

/** Model, icon and texture references (C-024): absolute URLs pass, archive syntax is refused, else a relative path. */
export function resolveReference(key: string, value: string): string {
  const v = value.trim();
  if (v.startsWith("?")) throw new Error(`${key}: query references are not supported: ${v}`);
  if (v.includes("!/")) throw new Error(`${key}: archive-entry references are not supported: ${v}`);
  if (/^https?:\/\//i.test(v)) return v;
  return v.replace(/\\/g, "/").replace(/^\.\//, "");
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function digests(
  props: Map<string, string>,
  i: number,
  keys: string[],
  warnings: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = props.get(`${k}#${i}`);
    if (v === undefined) continue;
    if (v.length === 0 || !BASE64.test(v)) {
      warnings.push(`${k}#${i}: malformed base64 digest ignored`);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function categoryFor(text: string, name: string, fallback: Category): Category {
  for (const source of [text, name]) for (const [re, cat] of CATEGORY_WORDS) if (re.test(source)) return cat;
  return fallback;
}

/** Parse a date written as yyyy-MM-dd (C-022); anything else is an error naming the key. */
export function parseCreationDate(key: string, v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) throw new Error(`${key}: can't parse date ${v}; expected yyyy-MM-dd`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3]))
    throw new Error(`${key}: can't parse date ${v}; not a calendar date`);
  return d.toISOString();
}

/** Equal-length parallel lists (C-012, C-014, O-085): the first mismatch is named. */
function parallelLists(
  props: Map<string, string>,
  i: number,
  first: string,
  others: string[],
): Map<string, string[]> | null {
  const head = props.get(`${first}#${i}`);
  if (head === undefined) return null;
  const out = new Map<string, string[]>();
  const n = list(head).length;
  out.set(first, list(head));
  for (const key of others) {
    const v = props.get(`${key}#${i}`);
    if (v === undefined) throw new Error(`${key}#${i}: expected ${n} values in ${key}, key missing`);
    const values = list(v);
    if (values.length !== n)
      throw new Error(`${key}#${i}: expected ${n} values in ${key}, got ${values.length}`);
    out.set(key, values);
  }
  return out;
}

function scan<T>(props: Map<string, string>, build: (i: number) => T): T[] {
  const out: T[] = [];
  for (let i = 1; props.has(`name#${i}`); i += 1) {
    if (parseBool(props.get(`ignored#${i}`), false)) continue;
    out.push(build(i));
  }
  return out;
}

function localizedFor(
  localized: Record<string, string> | undefined,
  i: number,
): { names: Record<string, string>; props: Map<string, Map<string, string>> } {
  const names: Record<string, string> = {};
  const props = new Map<string, Map<string, string>>();
  for (const [locale, text] of Object.entries(localized ?? {})) {
    const p = parseProperties(text);
    props.set(locale, p);
    const n = p.get(`name#${i}`);
    if (n) names[locale] = n;
  }
  return { names, props };
}

export function importFlatCatalog(text: string, options: FlatImportOptions): FlatImportResult<ImportedPiece> {
  const props = parseProperties(text);
  const warnings: string[] = [];
  const ids = new Set<string>();
  const currency = options.currency ?? "USD";
  try {
    const items = scan(props, (i): ImportedPiece => {
      for (const k of REQUIRED_PIECE_KEYS)
        if (!props.has(`${k}#${i}`)) throw new Error(`missing mandatory key ${k}#${i}`);
      const get = (k: string) => props.get(`${k}#${i}`);
      const name = get("name") as string;
      const wCm = numberOf(`width#${i}`, get("width") as string);
      const dCm = numberOf(`depth#${i}`, get("depth") as string);
      const hCm = numberOf(`height#${i}`, get("height") as string);
      for (const [k, v] of [
        ["width", wCm],
        ["depth", dCm],
        ["height", hCm],
      ] as const)
        if (v <= 0) throw new Error(`${k}#${i}: must be greater than zero, got ${v}`);
      const door = parseBool(get("doorOrWindow"), false);
      const movable = parseBool(get("movable"), true);
      const lights = parallelLists(props, i, "lightSourceX", [
        "lightSourceY",
        "lightSourceZ",
        "lightSourceColor",
      ]);
      if (lights && props.has(`lightSourceDiameter#${i}`)) {
        const diameters = list(props.get(`lightSourceDiameter#${i}`) as string);
        if (diameters.length !== (lights.get("lightSourceX") as string[]).length)
          throw new Error(
            `lightSourceDiameter#${i}: expected ${(lights.get("lightSourceX") as string[]).length} values`,
          );
      }
      const shelfBoxes = get("shelfBoxes") !== undefined ? list(get("shelfBoxes") as string) : null;
      if (shelfBoxes && shelfBoxes.length % 6 !== 0)
        throw new Error(`shelfBoxes#${i}: expected a multiple of 6 values, got ${shelfBoxes.length}`);
      const shelfElevations =
        get("shelfElevations") !== undefined ? list(get("shelfElevations") as string) : null;
      // C-015 subtype: door or window, light, shelf unit, else by words
      const categoryText = get("category") as string;
      let category: Category;
      if (door) category = /window/i.test(`${categoryText} ${name}`) ? "window" : "door";
      else if (lights || get("lightSourceMaterialName") !== undefined) category = "lighting";
      else if (shelfBoxes || shelfElevations) category = "storage";
      else category = categoryFor(categoryText, name, "other");
      // id: explicit ids must be unique (C-026 reversed); derived ids get a suffix instead of clashing
      const explicit = get("id");
      let id = explicit ? slug(explicit) : slug(options.libraryId, name);
      if (explicit) {
        if (ids.has(id)) throw new Error(`id#${i}: duplicate id ${id}`);
      } else if (ids.has(id)) id = `${id}-${i}`;
      ids.add(id);
      if (parseBool(get("multiPartModel"), false))
        throw new Error(`multiPartModel#${i}: multi-part models are not supported; provide a single glTF`);
      const modelRotation =
        get("modelRotation") !== undefined ? parseMatrix(get("modelRotation") as string) : null;
      const flags =
        get("modelFlags") !== undefined ? numberOf(`modelFlags#${i}`, get("modelFlags") as string) : 0;
      if (!Number.isInteger(flags)) throw new Error(`modelFlags#${i}: not an integer: ${get("modelFlags")}`);
      const createdAt =
        get("creationDate") !== undefined
          ? parseCreationDate(`creationDate#${i}`, get("creationDate") as string)
          : options.now;
      const tags =
        get("tags") !== undefined
          ? (get("tags") as string)
              .split(/\s*,\s*/)
              .map((t) => t.trim())
              .filter(Boolean)
          : [];
      const dropCm =
        get("dropOnTopElevation") !== undefined
          ? numberOf(`dropOnTopElevation#${i}`, get("dropOnTopElevation") as string)
          : null;
      const dropRatio = dropCm === null ? 1 : dropCm < 0 ? null : Math.min(1, dropCm / hCm);
      const elevationCm =
        get("elevation") !== undefined ? numberOf(`elevation#${i}`, get("elevation") as string) : 0;
      const priceText = get("price");
      const price =
        priceText !== undefined
          ? {
              amount: numberOf(`price#${i}`, priceText),
              currency: (get("currency") ?? currency).toUpperCase(),
              type: "list" as const,
              sourceUrl: null,
              capturedAt: options.now,
              expiresAt: new Date(Date.parse(options.now) + 90 * 86_400_000).toISOString(),
            }
          : null;
      const specs: Record<string, string | number | boolean> = {};
      if (flags & 1) specs.backFaceShown = true;
      if (flags & 2) specs.edgeColourHidden = true;
      if (lights) specs.lightCount = (lights.get("lightSourceX") as string[]).length;
      if (shelfBoxes) specs.shelfBoxes = shelfBoxes.length / 6;
      if (shelfElevations) specs.shelfLevels = shelfElevations.length;
      if (get("information") !== undefined) specs.information = get("information") as string;
      const opening = door ? openingOf(props, i, wCm, dCm, options.source) : null;
      const deformable = door
        ? (opening as { deformable: boolean }).deformable
        : parseBool(get("deformable"), true);
      const product: Product = {
        id,
        make: get("creator") ?? options.libraryId,
        model: name,
        variant: null,
        name,
        category,
        dims: { w: cmToMm(wCm), d: cmToMm(dCm), h: cmToMm(hCm) },
        weightKg: null,
        mount: {
          kinds: isOpeningCategory(category) ? ["wall"] : movable ? ["floor"] : ["floor"],
          vesa: null,
          defaultHeight: elevationCm > 0 ? cmToMm(elevationCm) : null,
        },
        mountPoints: isOpeningCategory(category)
          ? []
          : [{ name: "top", kind: "surface", dropRatio, offset: null }],
        clearance: null,
        deformable,
        meshRotation: modelRotation,
        assetKey: null,
        materialSlots: [],
        presets: [],
        opening: opening ? opening.spec : null,
        specs,
        price,
        verification: {
          status: "unverified",
          confidence: 0.5,
          sources: [],
          verifiedAt: null,
          notes: `imported from flat library ${options.libraryId}`,
        },
        lifecycle: "unknown",
        tags,
        aliases: [],
        createdAt,
        updatedAt: options.now,
      };
      const loc = localizedFor(options.localized, i);
      return {
        product,
        modelFile: resolveReference(`model#${i}`, get("model") as string),
        iconFile: resolveReference(`icon#${i}`, get("icon") as string),
        planIconFile:
          get("planIcon") !== undefined ? resolveReference(`planIcon#${i}`, get("planIcon") as string) : null,
        modelBytes:
          get("modelSize") !== undefined ? numberOf(`modelSize#${i}`, get("modelSize") as string) : null,
        declaredDigests: digests(props, i, ["iconDigest", "planIconDigest", "modelDigest"], warnings),
        localizedNames: loc.names,
      };
    });
    return { ok: true, items, warnings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Door and window fields in centimetres to fractions of the piece (O-007..O-012, C-010..C-013, O-084..O-087). */
function openingOf(
  props: Map<string, string>,
  i: number,
  wCm: number,
  dCm: number,
  source: "library" | "user",
): { spec: Product["opening"]; deformable: boolean } {
  const get = (k: string) => props.get(`doorOrWindow${k}#${i}`);
  const fraction = (key: string, v: string | undefined, fallback: number, denominator: number) =>
    v === undefined ? fallback : numberOf(`doorOrWindow${key}#${i}`, v) / denominator;
  let thickness = fraction("WallThickness", get("WallThickness"), 1, dCm);
  let distance = fraction("WallDistance", get("WallDistance"), 0, dCm);
  let cutBothSides = parseBool(get("WallCutOutOnBothSides"), true);
  let deformable = parseBool(get("WidthDepthDeformable"), true);
  let cutOutPath: string | null = get("CutOutShape") ?? null;
  if (source === "user") {
    // O-012: a modifiable piece never carries the library-only refinements
    cutBothSides = true;
    deformable = true;
    cutOutPath = null;
  }
  thickness = Math.min(1, Math.max(0, thickness));
  distance = Math.min(1, Math.max(0, distance));
  const lists = parallelLists(props, i, "doorOrWindowSashXAxis", [
    "doorOrWindowSashYAxis",
    "doorOrWindowSashWidth",
    "doorOrWindowSashStartAngle",
    "doorOrWindowSashEndAngle",
  ]);
  const sashes: Sash[] = [];
  if (lists) {
    const x = lists.get("doorOrWindowSashXAxis") as string[];
    const y = lists.get("doorOrWindowSashYAxis") as string[];
    const w = lists.get("doorOrWindowSashWidth") as string[];
    const s = lists.get("doorOrWindowSashStartAngle") as string[];
    const e = lists.get("doorOrWindowSashEndAngle") as string[];
    for (let k = 0; k < x.length; k += 1)
      sashes.push({
        xAxis: numberOf(`doorOrWindowSashXAxis#${i}`, x[k] as string) / wCm,
        yAxis: numberOf(`doorOrWindowSashYAxis#${i}`, y[k] as string) / dCm,
        width: Math.min(1, numberOf(`doorOrWindowSashWidth#${i}`, w[k] as string) / wCm),
        startAngle: numberOf(`doorOrWindowSashStartAngle#${i}`, s[k] as string),
        endAngle: numberOf(`doorOrWindowSashEndAngle#${i}`, e[k] as string),
      });
  }
  return {
    spec: {
      embed: { thickness, distance, width: 1, left: 0, height: 1, top: 0 },
      cutOutPath,
      cutBothSides,
      sashes,
    },
    deformable,
  };
}

export function importFlatTextures(
  text: string,
  options: FlatImportOptions,
): FlatImportResult<ImportedTexture> {
  const props = parseProperties(text);
  const warnings: string[] = [];
  const ids = new Set<string>();
  try {
    const items = scan(props, (i): ImportedTexture => {
      for (const k of REQUIRED_TEXTURE_KEYS)
        if (!props.has(`${k}#${i}`)) throw new Error(`missing mandatory key ${k}#${i}`);
      const get = (k: string) => props.get(`${k}#${i}`);
      const name = get("name") as string;
      const explicit = get("id");
      let id = `${options.libraryId}/${explicit ? slug(explicit) : slug(name)}`;
      if (explicit) {
        if (ids.has(id)) throw new Error(`id#${i}: duplicate id ${id}`);
      } else if (ids.has(id)) id = `${id}-${i}`;
      ids.add(id);
      const wCm = numberOf(`width#${i}`, get("width") as string);
      const hCm = numberOf(`height#${i}`, get("height") as string);
      if (wCm <= 0 || hCm <= 0) throw new Error(`width#${i}/height#${i}: must be greater than zero`);
      return {
        id,
        name,
        category: get("category") as string,
        imageFile: resolveReference(`image#${i}`, get("image") as string),
        widthMm: cmToMm(wCm),
        heightMm: cmToMm(hCm),
        creator: get("creator") ?? null,
        declaredDigests: digests(props, i, ["imageDigest"], warnings),
        localizedNames: localizedFor(options.localized, i).names,
      };
    });
    return { ok: true, items, warnings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
