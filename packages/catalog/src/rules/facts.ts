// Facts rules read from a project (spec 07 section 2): which items sit in which room, what product each
// is, heights and footprints, and the functions expressions call (count, spec, distance, clearances).
// Pure: the project, its snapshots and an optional live catalog are the only inputs.
import type { Item, Level, Opening, Point, Project, Room, Size3 } from "@fpv/ir";
import { derive, poly } from "@fpv/ir";
import { ExprError, Handle, num, type Scope, str, type Value } from "./expr.js";

export type SpecValue = string | number | boolean;

export interface PriceInfo {
  amount: number;
  /** null when the source gave a bare number: the project currency is assumed. */
  currency: string | null;
  type: "list" | "street" | "quote";
  sourceUrl: string | null;
  capturedAt: string | null;
  expiresAt: string | null;
}

/** What the BOM needs to know about a product, from a project snapshot or a catalog record. */
export interface ProductInfo {
  id: string;
  make: string | null;
  model: string | null;
  name: string;
  category: string;
  dims: Size3 | null;
  weightKg: number | null;
  specs: Record<string, SpecValue>;
  price: PriceInfo | null;
  status: "verified" | "unverified" | "rejected" | "manual";
  snapshotAt: string | null;
}

/** The live catalog, when there is one: candidates for rule-added products (ADR-009 D4). */
export interface BomCatalog {
  byCategory?(category: string): readonly unknown[];
  product?(id: string): unknown;
}

const STATUSES = new Set(["verified", "unverified", "rejected", "manual"]);

/** Normalise a snapshot, a catalog Product or a tools CatalogProduct into ProductInfo. */
export function productInfo(raw: unknown): ProductInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.category !== "string") return null;
  const v = r.verification as { status?: unknown } | undefined;
  const statusRaw = v?.status ?? r.status;
  const status =
    typeof statusRaw === "string" && STATUSES.has(statusRaw)
      ? (statusRaw as ProductInfo["status"])
      : "unverified";
  let price: PriceInfo | null = null;
  if (typeof r.price === "number")
    price = {
      amount: r.price,
      currency: null,
      type: "list",
      sourceUrl: null,
      capturedAt: null,
      expiresAt: null,
    };
  else if (r.price && typeof r.price === "object") {
    const p = r.price as Record<string, unknown>;
    if (typeof p.amount === "number")
      price = {
        amount: p.amount,
        currency: typeof p.currency === "string" ? p.currency.toUpperCase() : null,
        type: p.type === "street" || p.type === "quote" ? p.type : "list",
        sourceUrl: typeof p.sourceUrl === "string" ? p.sourceUrl : null,
        capturedAt: typeof p.capturedAt === "string" ? p.capturedAt : null,
        expiresAt: typeof p.expiresAt === "string" ? p.expiresAt : null,
      };
  }
  const dims = r.dims as Size3 | undefined;
  return {
    id: r.id,
    make: typeof r.make === "string" ? r.make : null,
    model: typeof r.model === "string" ? r.model : null,
    name: typeof r.name === "string" ? r.name : r.id,
    category: r.category,
    dims: dims && typeof dims.w === "number" ? dims : null,
    weightKg: typeof r.weightKg === "number" ? r.weightKg : null,
    specs: r.specs && typeof r.specs === "object" ? (r.specs as Record<string, SpecValue>) : {},
    price,
    status,
    snapshotAt: typeof r.snapshotAt === "string" ? r.snapshotAt : null,
  };
}

const RECIPE_CATEGORY: Readonly<Record<string, string>> = {
  table: "table",
  chair: "chair",
  display: "display",
  "video-bar": "video-bar",
  "ceiling-speaker": "ceiling-speaker",
  "ceiling-mic": "ceiling-mic",
  box: "other",
  cylinder: "other",
};

export function recipeKey(item: Item): string | null {
  if (item.ref.kind !== "recipe") return null;
  const r = item.ref.recipe;
  const s = derive.recipeSize(r);
  switch (r.kind) {
    case "table":
      return `recipe:table:${r.shape}:${s.w}x${s.d}x${s.h}`;
    case "display":
      return `recipe:display:${r.diagonalIn}`;
    case "ceiling-speaker":
      return `recipe:ceiling-speaker:${r.diameter}`;
    case "cylinder":
      return `recipe:cylinder:${r.diameter}x${r.height}`;
    default:
      return `recipe:${r.kind}:${s.w}x${s.d}x${s.h}`;
  }
}

export function recipeDescription(item: Item): string {
  if (item.ref.kind !== "recipe") return "";
  const r = item.ref.recipe;
  const s = derive.recipeSize(r);
  switch (r.kind) {
    case "table":
      return `Table ${r.shape} ${s.w} x ${s.d} (placeholder)`;
    case "chair":
      return "Chair (placeholder)";
    case "display":
      return `${r.diagonalIn} inch display (placeholder)`;
    case "video-bar":
      return `Video bar ${s.w} wide (placeholder)`;
    case "ceiling-speaker":
      return `Ceiling speaker ${r.diameter} (placeholder)`;
    case "ceiling-mic":
      return `Ceiling microphone ${s.w} x ${s.d} (placeholder)`;
    case "box":
      return `${r.label || "Box"} ${s.w} x ${s.d} x ${s.h} (placeholder)`;
    case "cylinder":
      return `${r.label || "Cylinder"} ${r.diameter} x ${r.height} (placeholder)`;
  }
}

export interface ItemFacts {
  item: Item;
  category: string;
  product: ProductInfo | null;
  recipe: string | null;
  specs: Record<string, SpecValue>;
  size: Size3 | null;
  footprint: Point[] | null;
  room: Room | null;
  level: Level;
  /** Height of the item's centre above its level floor, mm. */
  centreHeight: number;
  /** Where a cable meets it: the ceiling for ceiling items, the centre for wall items, the top otherwise. */
  connectionHeight: number;
}

export class ProjectFacts {
  readonly items: ItemFacts[];
  readonly rooms: Room[];
  readonly levels: Level[];
  private readonly byRoom = new Map<string, ItemFacts[]>();
  private readonly byLevel = new Map<string, ItemFacts[]>();
  readonly products = new Map<string, ProductInfo>();

  constructor(
    readonly project: Project,
    readonly catalog: BomCatalog | null = null,
  ) {
    this.levels = [...project.levels].sort(derive.compareLevels);
    const levelRank = new Map(this.levels.map((l, i) => [l.id, i]));
    this.rooms = [...project.rooms].sort(
      (a, b) => (levelRank.get(a.levelId) ?? 0) - (levelRank.get(b.levelId) ?? 0) || a.id.localeCompare(b.id),
    );
    for (const [id, snap] of Object.entries(project.catalogRefs)) {
      const info = productInfo(snap);
      if (info) this.products.set(id, info);
    }
    const sizes: derive.SizeSource = {
      product: (id) => {
        const p = this.product(id);
        return p?.dims ? { dims: p.dims, deformable: false } : null;
      },
    };
    this.items = [...project.items]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => {
        const level = derive.levelOf(project, item.levelId) ?? (this.levels[0] as Level);
        const product = item.ref.kind === "product" ? this.product(item.ref.productId) : null;
        const recipe = recipeKey(item);
        const size = derive.itemSize(item, sizes);
        const room =
          (item.roomId ? project.rooms.find((r) => r.id === item.roomId) : null) ??
          derive.containingRoom(project, item.levelId, item.position);
        const specs: Record<string, SpecValue> = { ...(product?.specs ?? {}) };
        if (item.ref.kind === "recipe" && item.ref.recipe.kind === "display")
          specs.diagonalIn ??= item.ref.recipe.diagonalIn;
        const h = size?.h ?? 0;
        const ceiling = this.ceilingOf(room, level);
        const connectionHeight =
          item.mount.kind === "ceiling"
            ? ceiling
            : item.mount.kind === "wall"
              ? item.elevation + h / 2
              : item.elevation + h;
        return {
          item,
          category:
            product?.category ??
            (item.ref.kind === "recipe" ? (RECIPE_CATEGORY[item.ref.recipe.kind] ?? "other") : "other"),
          product,
          recipe,
          specs,
          size,
          footprint: size ? derive.itemFootprint(item, size) : null,
          room,
          level,
          centreHeight: item.elevation + h / 2,
          connectionHeight,
        } satisfies ItemFacts;
      });
    for (const f of this.items) {
      const rk = f.room?.id ?? `level:${f.level.id}`;
      this.byRoom.set(rk, [...(this.byRoom.get(rk) ?? []), f]);
      this.byLevel.set(f.level.id, [...(this.byLevel.get(f.level.id) ?? []), f]);
    }
  }

  /** A project snapshot first (the project is self-contained), then the live catalog. */
  product(id: string): ProductInfo | null {
    const known = this.products.get(id);
    if (known) return known;
    const live = this.catalog?.product ? productInfo(this.catalog.product(id)) : null;
    if (live) this.products.set(id, live);
    return live;
  }

  inRoom(room: Room): ItemFacts[] {
    return this.byRoom.get(room.id) ?? [];
  }

  /** Items on a level that no room contains. */
  unroomed(level: Level): ItemFacts[] {
    return this.byRoom.get(`level:${level.id}`) ?? [];
  }

  onLevel(level: Level): ItemFacts[] {
    return this.byLevel.get(level.id) ?? [];
  }

  levelOf(id: string): Level | null {
    return this.levels.find((l) => l.id === id) ?? null;
  }

  ceilingOf(room: Room | null, level: Level): number {
    return room?.ceilingHeight ?? level.height;
  }
}

// ---- functions -------------------------------------------------------------------------------------

export interface ScopeInput {
  facts: ProjectFacts;
  /** Items the counting functions see. */
  items: readonly ItemFacts[];
  room: Room | null;
  level: Level | null;
  packFacts: Readonly<Record<string, number | readonly number[]>>;
  trigger?: ItemFacts | null;
  candidate?: ProductInfo | null;
  locals?: Readonly<Record<string, Value>>;
}

function fieldOf(f: ItemFacts, key: string): SpecValue | undefined {
  if (key in f.specs) return f.specs[key];
  switch (key) {
    case "w":
      return f.size?.w;
    case "d":
      return f.size?.d;
    case "h":
      return f.size?.h;
    case "weightKg":
      return f.product?.weightKg ?? undefined;
    case "elevation":
      return f.item.elevation;
    case "centreHeight":
      return f.centreHeight;
    case "connectionHeight":
      return f.connectionHeight;
    case "mount":
      return f.item.mount.kind;
    case "make":
      return f.product?.make ?? undefined;
    case "category":
      return f.category;
    default:
      return undefined;
  }
}

function compare(a: SpecValue, op: string, b: Value): boolean {
  if (op === "==") return typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : a === b;
  if (op === "!=") return !compare(a, "==", b);
  if (typeof a !== "number" || typeof b !== "number") return false;
  if (op === "<") return a < b;
  if (op === "<=") return a <= b;
  if (op === ">") return a > b;
  if (op === ">=") return a >= b;
  throw new ExprError(`countWhere does not know the operator ${op}`);
}

function horizontal(a: ItemFacts, b: ItemFacts): number {
  return Math.hypot(a.item.position.x - b.item.position.x, a.item.position.y - b.item.position.y);
}

/** Cable run via the ceiling (spec 07): horizontal Manhattan distance plus a drop at each end, mm. */
export function cableRun(facts: ProjectFacts, a: ItemFacts, b: ItemFacts): number {
  const dx = Math.abs(a.item.position.x - b.item.position.x);
  const dy = Math.abs(a.item.position.y - b.item.position.y);
  const drop = (f: ItemFacts) => Math.max(0, facts.ceilingOf(f.room, f.level) - f.connectionHeight);
  return dx + dy + drop(a) + drop(b);
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/** Distance along a ray to the first crossing of a ring's edges, or Infinity. */
function rayToRing(p: Point, dir: Point, ring: readonly Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const denom = cross(dir.x, dir.y, sx, sy);
    if (Math.abs(denom) < 1e-12) continue;
    const qx = a.x - p.x;
    const qy = a.y - p.y;
    const t = cross(qx, qy, sx, sy) / denom;
    const u = cross(qx, qy, dir.x, dir.y) / denom;
    if (t >= -1e-6 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.min(best, Math.max(0, t));
  }
  return best;
}

/** Free distance behind one item: from its back edge to the room boundary or the nearest floor item. */
export function clearanceBehind(f: ItemFacts, others: readonly ItemFacts[]): number {
  if (!f.size || !f.room) throw new ExprError(`${f.item.id} has no size or no room`);
  const a = (f.item.rotation * Math.PI) / 180;
  const dir = { x: -Math.sin(a), y: Math.cos(a) };
  const start = {
    x: f.item.position.x + dir.x * (f.size.d / 2),
    y: f.item.position.y + dir.y * (f.size.d / 2),
  };
  let best = rayToRing(start, dir, f.room.polygon);
  for (const o of others) {
    if (o === f || !o.footprint || o.item.parentId !== null || o.item.mount.kind !== "floor") continue;
    if (poly.containsPoint(o.footprint, start)) return 0;
    best = Math.min(best, rayToRing(start, dir, o.footprint));
  }
  return best;
}

/** The square a door sweeps on the room's side of its wall (width by width from the wall face). */
export function doorZone(project: Project, o: Opening, room: Room): Point[] | null {
  if (o.kind !== "door" || o.levelId !== room.levelId) return null;
  const w = project.walls.find((x) => x.id === o.wallId);
  if (!w) return null;
  const len = derive.wallLength(w);
  if (len === 0) return null;
  const c = derive.openingCentre(o, w);
  const ring = room.polygon;
  let near = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i += 1)
    near = Math.min(
      near,
      poly.distancePointSegment(c, ring[i] as Point, ring[(i + 1) % ring.length] as Point),
    );
  if (near > w.thickness / 2 + 60) return null;
  const u = { x: (w.end.x - w.start.x) / len, y: (w.end.y - w.start.y) / len };
  let n = derive.wallSideNormal(w, "left");
  const probe = { x: c.x + n.x * (w.thickness / 2 + 20), y: c.y + n.y * (w.thickness / 2 + 20) };
  if (!derive.roomContains(room, probe)) n = { x: -n.x, y: -n.y };
  const face = { x: c.x + n.x * (w.thickness / 2), y: c.y + n.y * (w.thickness / 2) };
  const hw = o.width / 2;
  const p1 = { x: face.x - u.x * hw, y: face.y - u.y * hw };
  const p2 = { x: face.x + u.x * hw, y: face.y + u.y * hw };
  return [
    p1,
    p2,
    { x: p2.x + n.x * o.width, y: p2.y + n.y * o.width },
    { x: p1.x + n.x * o.width, y: p1.y + n.y * o.width },
  ];
}

/** Floor items in the room whose footprint overlaps any door's swing square. */
export function itemsInDoorSwing(facts: ProjectFacts, room: Room, items: readonly ItemFacts[]): ItemFacts[] {
  const zones = facts.project.openings
    .map((o) => doorZone(facts.project, o, room))
    .filter((z): z is Point[] => z !== null);
  return items.filter(
    (f) =>
      f.footprint !== null &&
      f.item.mount.kind === "floor" &&
      zones.some((z) => poly.convexOverlapArea(f.footprint as Point[], z) > 1000),
  );
}

function ofCategory(items: readonly ItemFacts[], category: Value): ItemFacts[] {
  const c = str(category, "category");
  return items.filter((f) => f.category === c);
}

function numbersOf(items: readonly ItemFacts[], key: string): number[] {
  return items.map((f) => fieldOf(f, key)).filter((v): v is number => typeof v === "number");
}

export function makeScope(input: ScopeInput): Scope {
  const { facts, items, room, level, packFacts, trigger, candidate, locals } = input;
  const needRoom = (what: string): Room => {
    if (!room) throw new ExprError(`${what} needs a room`);
    return room;
  };
  const needTrigger = (what: string): ItemFacts => {
    if (!trigger) throw new ExprError(`${what} needs a triggering item`);
    return trigger;
  };
  const pairs = (a: Value, b: Value): [ItemFacts, ItemFacts][] => {
    const as = ofCategory(items, a);
    const bs = ofCategory(items, b);
    const out: [ItemFacts, ItemFacts][] = [];
    for (const x of as) for (const y of bs) if (x !== y) out.push([x, y]);
    if (out.length === 0) throw new ExprError(`no ${String(a)} and ${String(b)} items to measure between`);
    return out;
  };
  return {
    ident(name) {
      if (locals && name in locals) return locals[name] as Value;
      if (candidate) {
        if (name in candidate.specs) return candidate.specs[name] as Value;
        const fields: Record<string, Value | null | undefined> = {
          id: candidate.id,
          make: candidate.make,
          model: candidate.model,
          w: candidate.dims?.w,
          d: candidate.dims?.d,
          h: candidate.dims?.h,
          weightKg: candidate.weightKg,
        };
        const v = fields[name];
        if (v !== undefined && v !== null) return v;
      }
      if (name.startsWith("item.")) {
        const t = needTrigger(name);
        const v = fieldOf(t, name.slice(5));
        if (v === undefined) throw new ExprError(`${t.item.id} has no ${name.slice(5)}`);
        return v;
      }
      if (name.startsWith("room.")) {
        const r = needRoom(name);
        const lvl = facts.levelOf(r.levelId) ?? level;
        switch (name.slice(5)) {
          case "area":
            return derive.roomArea(r);
          case "areaM2":
            return derive.roomArea(r) / 1e6;
          case "perimeter":
            return derive.roomPerimeter(r);
          case "capacity":
            return r.capacity ?? ofCategory(items, "chair").length;
          case "ceilingHeight":
            return lvl ? facts.ceilingOf(r, lvl) : (r.ceilingHeight ?? 0);
          case "purpose":
            return r.purpose;
          case "name":
            return r.name ?? "";
          default:
            throw new ExprError(`unknown identifier ${name}`);
        }
      }
      if (name.startsWith("level.")) {
        if (!level) throw new ExprError(`${name} needs a level`);
        if (name === "level.height") return level.height;
        if (name === "level.elevation") return level.elevation;
        throw new ExprError(`unknown identifier ${name}`);
      }
      if (name in packFacts) return packFacts[name] as Value;
      throw new ExprError(`unknown identifier ${name}`);
    },
    call(name, args) {
      const arity = (k: number) => {
        if (args.length !== k) throw new ExprError(`${name} takes ${k} argument${k === 1 ? "" : "s"}`);
      };
      switch (name) {
        case "count":
          arity(1);
          return ofCategory(items, args[0] as Value).length;
        case "countWhere": {
          arity(4);
          const key = str(args[1] as Value, "countWhere key");
          const op = str(args[2] as Value, "countWhere operator");
          return ofCategory(items, args[0] as Value).filter((f) => {
            const v = fieldOf(f, key);
            return v !== undefined && compare(v, op, args[3] as Value);
          }).length;
        }
        case "spec": {
          arity(1);
          const t = needTrigger("spec");
          const key = str(args[0] as Value, "spec key");
          const v = t.specs[key];
          if (v === undefined) throw new ExprError(`${t.item.id} has no spec ${key}`);
          return v;
        }
        case "sum": {
          arity(2);
          return numbersOf(ofCategory(items, args[0] as Value), str(args[1] as Value, "sum key")).reduce(
            (s, v) => s + v,
            0,
          );
        }
        case "max":
        case "min": {
          arity(2);
          if (typeof args[0] === "number") {
            const a = num(args[0], name);
            const b = num(args[1] as Value, name);
            return name === "max" ? Math.max(a, b) : Math.min(a, b);
          }
          const key = str(args[1] as Value, `${name} key`);
          const values = numbersOf(ofCategory(items, args[0] as Value), key);
          if (values.length === 0) throw new ExprError(`no ${String(args[0])} with ${key}`);
          return name === "max" ? Math.max(...values) : Math.min(...values);
        }
        case "distance": {
          arity(2);
          const [a, b] = args as [Value, Value];
          if (!(a instanceof Handle) || !(b instanceof Handle))
            throw new ExprError("distance takes two items, e.g. distance(from, to)");
          return cableRun(facts, a.ref as ItemFacts, b.ref as ItemFacts);
        }
        case "farthest":
          arity(2);
          return Math.max(...pairs(args[0] as Value, args[1] as Value).map(([x, y]) => horizontal(x, y)));
        case "nearest":
          arity(2);
          return Math.min(...pairs(args[0] as Value, args[1] as Value).map(([x, y]) => horizontal(x, y)));
        case "clearanceBehind": {
          arity(1);
          const subjects = ofCategory(items, args[0] as Value);
          if (subjects.length === 0) throw new ExprError(`no ${String(args[0])} items`);
          return Math.min(...subjects.map((f) => clearanceBehind(f, items)));
        }
        case "doorSwingBlocked":
          arity(0);
          return itemsInDoorSwing(facts, needRoom("doorSwingBlocked"), items).length;
        default:
          throw new ExprError(`unknown function ${name}`);
      }
    },
  };
}
