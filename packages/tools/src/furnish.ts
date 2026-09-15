// Room recipes into item placements (spec 07 section 4, ADR-006 D2). Deterministic: the same room, pack
// and catalog always give the same commands, so a small model can furnish a room in one call and the
// result can be reviewed and replayed. Geometry is laid out in a frame anchored on the display wall:
// "along" runs from that wall into the room, "across" runs parallel to it.
import {
  type ExprScope,
  type ExprValue,
  evalCondition,
  evalNumber,
  type ProductInfo,
  productInfo,
  type RoomRecipe,
  type RulesPack,
} from "@fpv/catalog";
import type { Item, Point, PrimitiveRecipe, Project, Room, Size3, Wall } from "@fpv/ir";
import { derive, poly } from "@fpv/ir";
import type { CatalogSearch } from "./context.js";
import {
  freeSegments,
  roomSideOfWall,
  roomWallCompass,
  roomWallInterval,
  roomWalls,
  suggestedDisplayWall,
} from "./views.js";

export interface FurnishOptions {
  recipeId?: string | undefined;
  /** Remove the room's items first; otherwise categories the room already has are skipped. */
  replace?: boolean | undefined;
  preferMakes?: readonly string[] | undefined;
  /** Categories not to place, e.g. no video bar when the brief did not ask for video conferencing. */
  skipCategories?: readonly string[] | undefined;
}

export interface Unresolved {
  category: string;
  constraint: string;
  placedAs: string;
}

export interface FurnishPlan {
  recipe: RoomRecipe;
  commands: unknown[];
  unresolved: Unresolved[];
  warnings: string[];
  counts: Record<string, number>;
  displayWall: derive.Compass;
}

export class FurnishError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = "FurnishError";
  }
}

type Ref = { kind: "product"; productId: string } | { kind: "recipe"; recipe: PrimitiveRecipe };
type Mount = { kind: "floor" | "wall" | "ceiling"; targetId: string | null };
type Step = RoomRecipe["steps"][number];

/** Seats a room without a capacity gets: one per 3 m² of floor. */
const SEAT_AREA_M2 = 3;
/** Free space behind a chair (design rule chair-clearance). */
const CHAIR_CLEARANCE_MM = 900;
const CHAIR_GAP_MM = 50;
const STANDARD_DIAGONALS = [43, 50, 55, 65, 75, 85, 98, 110];
const OPPOSITE: Record<derive.Compass, derive.Compass> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

export function roomCapacity(room: Room): number {
  return room.capacity ?? Math.max(2, Math.floor(derive.roomArea(room) / 1e6 / SEAT_AREA_M2));
}

/** An explicit recipe id, else one for the room's purpose and capacity, else the closest capacity range. */
export function pickRecipe(pack: RulesPack, room: Room, recipeId?: string): RoomRecipe {
  if (recipeId) {
    const r = pack.recipes.find((x) => x.id === recipeId);
    if (!r)
      throw new FurnishError(
        "recipe.unknown",
        `recipe "${recipeId}" is not in the rules pack`,
        `use one of ${pack.recipes.map((x) => x.id).join(", ")}`,
      );
    return r;
  }
  if (pack.recipes.length === 0) throw new FurnishError("recipe.none", "the rules pack has no room recipes");
  const cap = roomCapacity(room);
  const gap = (r: RoomRecipe) =>
    cap < r.capacityRange[0]
      ? r.capacityRange[0] - cap
      : cap > r.capacityRange[1]
        ? cap - r.capacityRange[1]
        : 0;
  return (
    pack.recipes.find((r) => r.purpose === room.purpose && gap(r) === 0) ??
    pack.recipes.find((r) => gap(r) === 0) ??
    ([...pack.recipes].sort((a, b) => gap(a) - gap(b))[0] as RoomRecipe)
  );
}

const norm = (deg: number) => ((Math.round(deg) % 360) + 360) % 360;
/** Rotation that makes an item's front (local -y) face plan direction f. */
const facing = (f: Point) => norm((Math.atan2(f.x, -f.y) * 180) / Math.PI);
/** Rotation that lays an item's width (local x) along plan direction v. */
const axisAlong = (v: Point) => norm((Math.atan2(v.y, v.x) * 180) / Math.PI);
const neg = (v: Point): Point => ({ x: -v.x, y: -v.y });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;

function compassDir(c: derive.Compass, north: number): Point {
  const deg = { north, west: north + 90, south: north + 180, east: north - 90 }[c];
  const rad = (deg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

interface Frame {
  /** Outward through the display wall. */
  o: Point;
  /** Into the room, away from the display wall. */
  a: Point;
  /** Across, parallel to the display wall. */
  p: Point;
  face: number;
  depth: number;
  pMin: number;
  pMax: number;
}

function frameFor(room: Room, o: Point): Frame {
  const a = neg(o);
  const p = { x: -o.y, y: o.x };
  const face = Math.max(...room.polygon.map((v) => dot(v, o)));
  const depth = Math.max(...room.polygon.map((v) => face - dot(v, o)));
  const across = room.polygon.map((v) => dot(v, p));
  return { o, a, p, face, depth, pMin: Math.min(...across), pMax: Math.max(...across) };
}

function at(f: Frame, along: number, across: number): Point {
  const base = f.face - along;
  return { x: Math.round(f.o.x * base + f.p.x * across), y: Math.round(f.o.y * base + f.p.y * across) };
}

/** Plan direction for a direction given in frame terms. */
function dir(f: Frame, along: number, across: number): Point {
  return { x: f.a.x * along + f.p.x * across, y: f.a.y * along + f.p.y * across };
}

function recipeDescription(r: PrimitiveRecipe): string {
  const s = derive.recipeSize(r);
  if (r.kind === "display") return `${r.diagonalIn} inch display recipe`;
  if (r.kind === "box" || r.kind === "cylinder") return `${r.label} recipe ${s.w} x ${s.d} x ${s.h}`;
  return `${r.kind} recipe ${s.w} x ${s.d} x ${s.h}`;
}

function categoryOfItem(item: Item, p: Project, catalog: CatalogSearch): string {
  if (item.ref.kind === "recipe") {
    const k = item.ref.recipe.kind;
    return k === "box" || k === "cylinder" ? "other" : k;
  }
  const snap = p.catalogRefs[item.ref.productId] as { category?: string } | undefined;
  return snap?.category ?? catalog.product(item.ref.productId)?.category ?? "other";
}

export function planFurnishing(
  p: Project,
  room: Room,
  pack: RulesPack,
  catalog: CatalogSearch,
  sizes: derive.SizeSource,
  options: FurnishOptions = {},
): FurnishPlan {
  const recipe = pickRecipe(pack, room, options.recipeId);
  const level = derive.levelOf(p, room.levelId);
  if (!level) throw new FurnishError("ref.missing", `level "${room.levelId}" does not resolve`);
  const warnings: string[] = [];
  const unresolved: Unresolved[] = [];
  const commands: unknown[] = [];
  const counts: Record<string, number> = {};
  const ceiling = room.ceilingHeight ?? level.height;
  const skip = new Set(options.skipCategories ?? []);

  const inRoom = p.items.filter(
    (i) =>
      i.levelId === room.levelId &&
      (i.roomId === room.id || (i.roomId === null && derive.roomContains(room, i.position))),
  );
  if (options.replace && inRoom.length > 0) {
    const ids = new Set(inRoom.map((i) => i.id));
    commands.push({
      type: "item.delete",
      payload: {
        itemIds: inRoom.filter((i) => i.parentId === null || !ids.has(i.parentId)).map((i) => i.id),
        withDescendants: true,
      },
    });
  }
  const present = new Set(options.replace ? [] : inRoom.map((i) => categoryOfItem(i, p, catalog)));
  const told = new Set<string>();
  const blocked = (category: string): boolean => {
    if (skip.has(category)) return true;
    if (!present.has(category)) return false;
    if (!told.has(category))
      warnings.push(`the room already has ${category} items; kept them (replace: true refurnishes)`);
    told.add(category);
    return true;
  };

  // the display wall decides the frame, so it is chosen before any step runs
  const displayStep = recipe.steps.find((s): s is Extract<Step, { op: "display" }> => s.op === "display");
  const free = freeSegments(
    options.replace ? { ...p, items: p.items.filter((i) => !inRoom.includes(i)) } : p,
    room,
    sizes,
  );
  const side: derive.Compass =
    displayStep && displayStep.wall !== "auto"
      ? displayStep.wall
      : (suggestedDisplayWall(p, room, free) ?? "north");
  const frame = frameFor(room, compassDir(side, p.meta.north));
  const span = frame.pMax - frame.pMin;
  const midAcross = (frame.pMin + frame.pMax) / 2;
  const walls = roomWalls(p, room);
  const wallOn = (compass: derive.Compass, near: Point): Wall | null =>
    walls
      .filter((w) => roomWallCompass(p, w, room) === compass)
      .sort(
        (x, y) =>
          poly.distancePointSegment(near, x.start, x.end) - poly.distancePointSegment(near, y.start, y.end),
      )[0] ?? null;

  const seats = roomCapacity(room);
  const locals: Record<string, ExprValue> = {
    neededSeats: seats,
    seatDistanceMm: frame.depth,
    neededDiagonalIn: 0,
  };
  const scope = (cand?: ProductInfo): ExprScope => ({
    ident(name) {
      if (cand) {
        if (name in cand.specs) return cand.specs[name] as ExprValue;
        const fields: Record<string, ExprValue | null | undefined> = {
          id: cand.id,
          make: cand.make,
          model: cand.model,
          w: cand.dims?.w,
          d: cand.dims?.d,
          h: cand.dims?.h,
          weightKg: cand.weightKg,
        };
        const v = fields[name];
        if (v !== undefined && v !== null) return v;
      }
      if (name in locals) return locals[name] as ExprValue;
      switch (name) {
        case "room.capacity":
          return seats;
        case "room.area":
          return derive.roomArea(room);
        case "room.areaM2":
          return derive.roomArea(room) / 1e6;
        case "room.widthMm":
          return span;
        case "room.depthMm":
          return frame.depth;
        case "room.ceilingHeight":
          return ceiling;
        case "room.purpose":
          return room.purpose;
      }
      if (name in pack.facts) return pack.facts[name] as ExprValue;
      throw new Error(`unknown identifier ${name}`);
    },
    call(name) {
      throw new Error(`unknown function ${name}`);
    },
  });
  const number = (src: string, what: string, fallback: number): number => {
    const r = evalNumber(src, scope());
    if (r.ok) return r.value;
    warnings.push(`${recipe.id}: ${what} "${src}" could not be evaluated (${r.error}); used ${fallback}`);
    return fallback;
  };

  const FIT_KEY: Record<string, string> = {
    table: "seats",
    desk: "seats",
    display: "diagonalIn",
    "video-bar": "maxRoomDepthMm",
  };
  /** The best catalog product for a category, or a primitive recipe recorded as unresolved. */
  const resolve = (
    category: string,
    fallback: PrimitiveRecipe,
    fits: (s: Size3) => boolean = () => true,
  ): { ref: Ref; size: Size3 } => {
    const prefs = recipe.productPreferences.filter((x) => x.category === category);
    const constraint = prefs.length > 0 ? prefs.map((x) => `(${x.constraint})`).join(" and ") : "true";
    const makes = [...(options.preferMakes ?? []), ...prefs.flatMap((x) => x.preferMake)].map((m) =>
      m.toLowerCase(),
    );
    const pool = (catalog.byCategory?.(category) ?? [])
      .map(productInfo)
      .filter(
        (x): x is ProductInfo =>
          x !== null && x.category === category && x.status !== "rejected" && x.dims !== null,
      );
    const ok = pool.filter((c) => {
      if (!fits(c.dims as Size3)) return false;
      const r = evalCondition(constraint, scope(c));
      return r.ok && r.value;
    });
    const key = FIT_KEY[category];
    const fit = (c: ProductInfo) => (key && typeof c.specs[key] === "number" ? (c.specs[key] as number) : 0);
    const make = (c: ProductInfo) => {
      const i = makes.indexOf((c.make ?? "").toLowerCase());
      return i < 0 ? makes.length : i;
    };
    const status = (c: ProductInfo) => (c.status === "verified" || c.status === "manual" ? 0 : 1);
    const price = (c: ProductInfo) => c.price?.amount ?? Number.MAX_VALUE;
    ok.sort(
      (x, y) =>
        make(x) - make(y) ||
        status(x) - status(y) ||
        fit(x) - fit(y) ||
        price(x) - price(y) ||
        x.id.localeCompare(y.id),
    );
    const best = ok[0];
    if (best) return { ref: { kind: "product", productId: best.id }, size: best.dims as Size3 };
    if (!unresolved.some((u) => u.category === category))
      unresolved.push({
        category,
        constraint: pool.length > 0 ? `${constraint} and fits the room` : constraint,
        placedAs: recipeDescription(fallback),
      });
    return { ref: { kind: "recipe", recipe: fallback }, size: derive.recipeSize(fallback) };
  };

  const floor: Mount = { kind: "floor", targetId: null };
  const place = (
    category: string,
    r: { ref: Ref; size: Size3 },
    position: Point,
    rotation: number,
    elevation: number,
    mount: Mount,
  ) => {
    const rot = norm(rotation);
    commands.push({
      type: "item.place",
      payload: {
        levelId: room.levelId,
        ref: r.ref,
        position,
        rotation: rot,
        elevation: Math.round(elevation),
        mount: { ...mount, height: null },
        roomId: room.id,
        tags: [`recipe:${recipe.id}`],
        // the recipe computed exact positions; the placement pipeline must not move them
        magnetism: false,
      },
    });
    counts[category] = (counts[category] ?? 0) + 1;
    if (mount.kind === "floor") {
      const fp = derive.itemFootprint({ position, rotation: rot } as Item, r.size);
      if (!fp.every((q) => poly.containsPoint(room.polygon, q)))
        warnings.push(`a ${category} at (${position.x}, ${position.y}) does not fit inside the room`);
    }
  };

  let chairChoice: { ref: Ref; size: Size3 } | null = null;
  const chair = () => {
    chairChoice ??= resolve("chair", { kind: "chair", size: { w: 600, d: 600, h: 900 } });
    return chairChoice;
  };
  let table: { along: number; across: number; size: Size3; round: boolean } | null = null;
  const seatsAt: { along: number; across: number }[] = [];
  const displays: { across: number; size: Size3; elevation: number; wall: Wall | null }[] = [];
  const chairsStep = recipe.steps.find((s): s is Extract<Step, { op: "chairs" }> => s.op === "chairs");

  for (const step of recipe.steps) {
    switch (step.op) {
      case "table": {
        if (blocked("table")) break;
        const want = Math.max(1, Math.ceil(number(step.seatsExpr, "seatsExpr", seats)));
        locals.neededSeats = want;
        const c = chair();
        const round = step.shape === "round";
        const pitch = chairsStep?.pitchMm ?? 720;
        const reach = CHAIR_GAP_MM + c.size.d;
        const fits = (s: Size3) =>
          round
            ? s.w + 2 * reach <= Math.min(frame.depth, span)
            : s.w + 2 * step.clearanceMm <= frame.depth && 2 * (s.d / 2 + reach + CHAIR_CLEARANCE_MM) <= span;
        let fallback: PrimitiveRecipe;
        if (round) {
          const dia = want <= 4 ? 1200 : 1500;
          fallback = { kind: "table", size: { w: dia, d: dia, h: 740 }, shape: "round" };
        } else {
          const maxW = Math.max(800, Math.round(frame.depth - 2 * step.clearanceMm));
          const w = Math.min(Math.max(Math.ceil(want / 2) * pitch, 1200), maxW);
          const maxD = Math.max(700, Math.round(span - 2 * (reach + CHAIR_CLEARANCE_MM)));
          const d = Math.min(want > 8 ? 1400 : 1200, maxD);
          fallback = { kind: "table", size: { w, d, h: 740 }, shape: step.shape };
        }
        const r = resolve("table", fallback, fits);
        const along = frame.depth / 2;
        place(
          "table",
          r,
          at(frame, along, midAcross),
          round ? axisAlong(frame.a) : axisAlong(frame.a),
          0,
          floor,
        );
        table = { along, across: midAcross, size: r.size, round };
        if (!fits(r.size)) warnings.push(`the table leaves less than the recipe's clearance in this room`);
        break;
      }
      case "chairs": {
        if (blocked("chair")) break;
        if (!table) {
          warnings.push("chairs need a table from this recipe; skipped");
          break;
        }
        const t = table;
        const c = chair();
        const want = Math.max(1, Math.round(Number(locals.neededSeats)));
        const put = (along: number, across: number, front: Point) => {
          place("chair", c, at(frame, along, across), facing(front), 0, floor);
          seatsAt.push({ along, across });
        };
        if (t.round) {
          const radius = t.size.w / 2 + CHAIR_GAP_MM + c.size.d / 2;
          for (let i = 0; i < want; i += 1) {
            const ang = (2 * Math.PI * i) / want + Math.PI / want;
            const da = Math.cos(ang);
            const dp = Math.sin(ang);
            put(t.along + radius * da, t.across + radius * dp, dir(frame, -da, -dp));
          }
          break;
        }
        const nSide = Math.max(1, Math.floor(t.size.w / step.pitchMm));
        const sides = Math.min(want, 2 * nSide);
        const offAcross = t.size.d / 2 + CHAIR_GAP_MM + c.size.d / 2;
        const row = (n: number, sign: 1 | -1) => {
          for (let i = 0; i < n; i += 1)
            put(
              t.along + (i - (n - 1) / 2) * step.pitchMm,
              t.across + sign * offAcross,
              dir(frame, 0, -sign),
            );
        };
        row(Math.ceil(sides / 2), 1);
        row(Math.floor(sides / 2), -1);
        let rest = want - sides;
        const nEnd = Math.max(1, Math.floor(t.size.d / step.pitchMm));
        const end = (n: number, sign: 1 | -1) => {
          const along = t.along + sign * (t.size.w / 2 + CHAIR_GAP_MM + c.size.d / 2);
          for (let i = 0; i < n; i += 1)
            put(along, t.across + (i - (n - 1) / 2) * step.pitchMm, dir(frame, -sign, 0));
        };
        const far = Math.min(rest, nEnd);
        end(far, 1);
        rest -= far;
        if (rest > 0) {
          const near = Math.min(rest, nEnd);
          end(near, -1);
          rest -= near;
          warnings.push(`${near} seat(s) at the display end of the table face away from the display`);
        }
        if (rest > 0) warnings.push(`${rest} seat(s) do not fit around the table`);
        break;
      }
      case "arrange": {
        if (blocked(step.category)) break;
        if (step.pattern !== "rows") {
          warnings.push(`arrange pattern "${step.pattern}" is not supported by recipes yet; use rows`);
          break;
        }
        const want = Math.max(1, Math.ceil(number(step.countExpr, "countExpr", 1)));
        const c = chair();
        const gap = 600;
        const r = resolve(
          step.category,
          { kind: "table", size: { w: 1600, d: 700, h: 740 }, shape: "rect" },
          (s) => s.w <= span - 2 * gap,
        );
        const perRow = Math.max(1, Math.floor((span - 2 * gap + gap) / (r.size.w + gap)));
        const rowPitch = r.size.d + CHAIR_GAP_MM + c.size.d + step.spacingMm;
        const firstFront = Math.max(2500, Math.round(frame.depth * 0.2));
        let placed = 0;
        for (let k = 0; placed < want; k += 1) {
          const along = firstFront + r.size.d / 2 + k * rowPitch;
          if (along + r.size.d / 2 + CHAIR_GAP_MM + c.size.d + CHAIR_CLEARANCE_MM > frame.depth) break;
          const inRow = Math.min(perRow, want - placed);
          const total = inRow * r.size.w + (inRow - 1) * gap;
          for (let i = 0; i < inRow; i += 1) {
            const across = midAcross - total / 2 + r.size.w / 2 + i * (r.size.w + gap);
            place(step.category, r, at(frame, along, across), axisAlong(frame.p), 0, floor);
            for (let j = 0; j < step.seatsEach; j += 1) {
              const ca = along + r.size.d / 2 + CHAIR_GAP_MM + c.size.d / 2;
              const cx = across - r.size.w / 2 + ((j + 0.5) * r.size.w) / step.seatsEach;
              place("chair", c, at(frame, ca, cx), facing(frame.o), 0, floor);
              seatsAt.push({ along: ca, across: cx });
            }
          }
          placed += inRow;
        }
        if (placed < want) warnings.push(`only ${placed} of ${want} ${step.category} items fit in rows`);
        break;
      }
      case "display": {
        if (blocked("display")) break;
        const centre = table?.across ?? midAcross;
        const dist =
          seatsAt.length > 0
            ? Math.max(...seatsAt.map((s) => Math.hypot(s.along, s.across - centre)))
            : frame.depth;
        locals.seatDistanceMm = Math.round(dist);
        const diag = Math.ceil(number(step.diagonalExpr, "diagonalExpr", 65));
        locals.neededDiagonalIn = diag;
        const count = Math.max(1, Math.round(number(step.countExpr, "countExpr", 1)));
        const standard = STANDARD_DIAGONALS.find((x) => x >= diag) ?? diag;
        const r = resolve(
          "display",
          { kind: "display", diagonalIn: standard, bezelMm: 15 },
          (s) => count * s.w + (count - 1) * 200 <= span - 400,
        );
        const total = count * r.size.w + (count - 1) * 200;
        const elevation = step.centreHeightMm - r.size.h / 2;
        for (let k = 0; k < count; k += 1) {
          const raw = centre - total / 2 + r.size.w / 2 + k * (r.size.w + 200);
          const across = Math.min(Math.max(raw, frame.pMin + r.size.w / 2), frame.pMax - r.size.w / 2);
          const pos = at(frame, r.size.d / 2, across);
          const wall = wallOn(side, pos);
          if (!wall) warnings.push(`no ${side} wall found for the display; placed it standing`);
          place(
            "display",
            r,
            pos,
            facing(frame.a),
            elevation,
            wall ? { kind: "wall", targetId: wall.id } : floor,
          );
          displays.push({ across, size: r.size, elevation, wall });
        }
        break;
      }
      case "video-bar": {
        if (blocked("video-bar")) break;
        const d = displays[0];
        if (!d) {
          warnings.push("the video bar goes under a display from this recipe; skipped");
          break;
        }
        const r = resolve("video-bar", { kind: "video-bar", size: { w: 1000, d: 100, h: 100 } });
        let elevation = d.elevation - r.size.h - 50;
        if (elevation < 500) elevation = d.elevation + d.size.h + 50;
        place(
          "video-bar",
          r,
          at(frame, r.size.d / 2, d.across),
          facing(frame.a),
          elevation,
          d.wall ? { kind: "wall", targetId: d.wall.id } : floor,
        );
        break;
      }
      case "ceiling-array": {
        if (blocked(step.category)) break;
        const n = Math.max(step.minCount, Math.ceil(derive.roomArea(room) / 1e6 / step.perAreaM2 - 1e-9));
        if (n === 0) break;
        const fallback: PrimitiveRecipe =
          step.category === "ceiling-mic"
            ? { kind: "ceiling-mic", size: { w: 600, d: 600, h: 55 } }
            : { kind: "ceiling-speaker", diameter: 200 };
        const r = resolve(step.category, fallback);
        const spots: { along: number; across: number }[] = [];
        if (step.category === "ceiling-mic" && table && !table.round) {
          for (let i = 0; i < n; i += 1)
            spots.push({ along: table.along + ((i + 0.5) / n - 0.5) * table.size.w, across: table.across });
        } else {
          const cols = Math.min(n, Math.max(1, Math.ceil(Math.sqrt((n * frame.depth) / span))));
          const rows = Math.ceil(n / cols);
          for (let row = 0; row < rows; row += 1) {
            const inRow = Math.min(cols, n - row * cols);
            for (let col = 0; col < inRow; col += 1)
              spots.push({
                along: ((col + 0.5) * frame.depth) / inRow,
                across: frame.pMin + ((row + 0.5) * span) / rows,
              });
          }
        }
        for (const s of spots)
          place(step.category, r, at(frame, s.along, s.across), axisAlong(frame.a), ceiling - r.size.h, {
            kind: "ceiling",
            targetId: null,
          });
        break;
      }
      case "by-door": {
        if (blocked(step.category)) break;
        const doors = p.openings
          .filter((o) => o.kind === "door" && walls.some((w) => w.id === o.wallId))
          .sort((x, y) => x.id.localeCompare(y.id));
        if (doors.length === 0) {
          warnings.push(`the room has no door, so no ${step.category} was placed by it`);
          break;
        }
        const label = step.category === "scheduler" ? "Scheduler" : "Touch panel";
        const r = resolve(step.category, { kind: "box", size: { w: 250, d: 40, h: 170 }, label });
        let done = false;
        for (const o of doors) {
          const w = walls.find((x) => x.id === o.wallId) as Wall;
          const len = derive.wallLength(w);
          const u = { x: (w.end.x - w.start.x) / len, y: (w.end.y - w.start.y) / len };
          const inward = derive.wallSideNormal(w, roomSideOfWall(w, room));
          const normal = step.side === "inside" ? inward : neg(inward);
          const iv = roomWallInterval(w, room);
          const latch = o.swing?.hinge === "end" ? -1 : 1;
          for (const sign of [latch, -latch]) {
            const t = o.position * len + sign * (o.width / 2 + 150 + r.size.w / 2);
            const lo = t - r.size.w / 2;
            const hi = t + r.size.w / 2;
            if (lo < iv.fromMm || hi > iv.toMm) continue;
            const clash = p.openings.some((q) => {
              if (q.wallId !== w.id || q.id === o.id) return false;
              const qi = derive.openingAlongInterval(q, w);
              return qi.from < hi + 50 && qi.to > lo - 50;
            });
            if (clash) continue;
            const off = w.thickness / 2 + r.size.d / 2;
            const pos = {
              x: Math.round(w.start.x + u.x * t + normal.x * off),
              y: Math.round(w.start.y + u.y * t + normal.y * off),
            };
            place(step.category, r, pos, facing(normal), step.heightMm - r.size.h / 2, {
              kind: "wall",
              targetId: w.id,
            });
            done = true;
            break;
          }
          if (done) break;
        }
        if (!done) warnings.push(`no free wall beside a door for the ${step.category}`);
        break;
      }
      case "whiteboard": {
        if (blocked("whiteboard")) break;
        const r = resolve("whiteboard", {
          kind: "box",
          size: { w: 1800, d: 20, h: 1200 },
          label: "Whiteboard",
        });
        const pos = at(frame, frame.depth - r.size.d / 2, midAcross);
        const wall = wallOn(OPPOSITE[side], pos);
        if (!wall) {
          warnings.push("no wall opposite the display for the whiteboard; skipped");
          break;
        }
        const len = derive.wallLength(wall);
        const u = { x: (wall.end.x - wall.start.x) / len, y: (wall.end.y - wall.start.y) / len };
        const t = dot({ x: pos.x - wall.start.x, y: pos.y - wall.start.y }, u);
        const lo = t - r.size.w / 2;
        const hi = t + r.size.w / 2;
        if (
          p.openings.some(
            (q) =>
              q.wallId === wall.id &&
              derive.openingAlongInterval(q, wall).from < hi &&
              derive.openingAlongInterval(q, wall).to > lo,
          )
        ) {
          warnings.push("an opening is where the whiteboard would go; skipped");
          break;
        }
        place("whiteboard", r, pos, facing(frame.o), 900, { kind: "wall", targetId: wall.id });
        break;
      }
    }
  }
  return { recipe, commands, unresolved, warnings, counts, displayWall: side };
}
