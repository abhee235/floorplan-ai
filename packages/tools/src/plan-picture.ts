// A plan drawing made in the host (ADR-028 D11): what a model looks at before it calls a design done.
//
// It draws one level of a project -- walls by kind, doors and windows, rooms by number, furniture
// when asked -- into a PNG, with nothing but arithmetic and node's zlib. A design is previewed by
// building it into a scratch copy of the project and drawing that, so the picture is what
// build_design will draw and not a second drawing that could disagree with it. The editor's own
// render needs a browser tab, and an architect's design is not built yet when it most needs a look.
//
// Numbers rather than names on the rooms, with the legend in the tool's text: ten digits in a
// bitmap font are a few lines here, and a font for every key would be a dependency.
import { deflateSync } from "node:zlib";
import { encodePng } from "@fpv/assets";
import { derive, type Item, type Opening, type Point, type Project, type Wall } from "@fpv/ir";

type Rgb = readonly [number, number, number];

/** What each colour means, said once here and once in the caption the model reads. */
export const PLAN_COLOURS = {
  outside: [228, 228, 228],
  uncovered: [246, 206, 214],
  overlap: [255, 120, 40],
  room: [255, 255, 255],
  open: [255, 238, 186],
  circulation: [214, 229, 250],
  service: [196, 196, 196],
  exterior: [20, 20, 20],
  interior: [120, 120, 120],
  glass: [20, 105, 255],
  door: [225, 25, 25],
  entrance: [0, 165, 60],
  window: [0, 200, 225],
  item: [80, 80, 80],
  display: [215, 0, 175],
  label: [0, 0, 0],
} as const satisfies Record<string, Rgb>;

const SERVICE = new Set(["restroom", "toilet", "bathroom", "utility", "storage", "laundry", "garage"]);
const CIRCULATION = new Set(["corridor", "foyer"]);

/** 3 by 5 digits, and a 5 by 5 N for the north arrow. */
const GLYPHS: Record<string, readonly string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  N: ["10001", "11001", "10101", "10011", "10001"],
};

class Canvas {
  readonly rgb: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
    ground: Rgb,
  ) {
    this.rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i += 1) this.rgb.set(ground, i * 3);
  }

  set(x: number, y: number, c: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.rgb.set(c, (y * this.width + x) * 3);
  }

  rect(x0: number, y0: number, x1: number, y1: number, c: Rgb): void {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.height, Math.ceil(y1)); y += 1)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.width, Math.ceil(x1)); x += 1)
        this.set(x, y, c);
  }

  /** Scanline fill of a simple polygon in pixel coordinates, even-odd. */
  polygon(pts: readonly Point[], c: Rgb): void {
    if (pts.length < 3) return;
    const ys = pts.map((p) => p.y);
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const bottom = Math.min(this.height - 1, Math.ceil(Math.max(...ys)));
    for (let y = top; y <= bottom; y += 1) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i += 1) {
        const a = pts[i] as Point;
        const b = pts[(i + 1) % pts.length] as Point;
        if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc))
          xs.push(a.x + ((yc - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.round(xs[k] as number));
        const x1 = Math.min(this.width - 1, Math.round(xs[k + 1] as number) - 1);
        for (let x = x0; x <= x1; x += 1) this.set(x, y, c);
      }
    }
  }

  /** A straight band from a to b, half its width either side of the line. */
  band(a: Point, b: Point, half: number, c: Rgb): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const nx = (-dy / len) * half;
    const ny = (dx / len) * half;
    this.polygon(
      [
        { x: a.x + nx, y: a.y + ny },
        { x: b.x + nx, y: b.y + ny },
        { x: b.x - nx, y: b.y - ny },
        { x: a.x - nx, y: a.y - ny },
      ],
      c,
    );
  }

  text(s: string, x: number, y: number, scale: number, c: Rgb): void {
    let cursor = x;
    for (const ch of s) {
      const g = GLYPHS[ch];
      if (!g) {
        cursor += 2 * scale;
        continue;
      }
      g.forEach((row, j) => {
        for (let i = 0; i < row.length; i += 1)
          if (row[i] === "1")
            this.rect(cursor + i * scale, y + j * scale, cursor + (i + 1) * scale, y + (j + 1) * scale, c);
      });
      cursor += ((g[0]?.length ?? 3) + 1) * scale;
    }
  }

  textWidth(s: string, scale: number): number {
    return [...s].reduce((n, ch) => n + ((GLYPHS[ch]?.[0]?.length ?? 1) + 1) * scale, 0) - scale;
  }
}

export interface PlanPictureOptions {
  /** Width of the picture in pixels; the height follows from the plan. */
  widthPx?: number;
  /** The label each room carries, by room id; rooms without one are drawn unlabelled. */
  labels?: ReadonlyMap<string, string>;
  /** Draw the furniture too, with displays marked, for a level that has been furnished. */
  items?: boolean;
  /** Item sizes, needed when items are drawn. */
  sizes?: derive.SizeSource;
}

export interface PlanPicture {
  png: Uint8Array;
  width: number;
  height: number;
  /** The project's north is the top of the picture, as the key says; else the arrow shows it. */
  northUp: boolean;
}

/** A wall on the outside of the building: a solid outside wall, or a glass one as thick as the shell. */
function onShell(w: Wall): boolean {
  return w.kind === "exterior" || (w.kind === "glass" && w.thickness >= 150);
}

function itemCategory(p: Project, it: Item): string {
  if (it.ref.kind === "recipe") return it.ref.recipe.kind;
  const snap = p.catalogRefs[it.ref.productId] as { category?: string } | undefined;
  return snap?.category ?? "";
}

/**
 * Draw a level, north up.
 *
 * Walls: black outside, grey plaster, blue glass, and nothing where two open rooms meet. Doors are
 * red, the entrance green, windows cyan. Open floor is pale yellow, corridors pale blue, service
 * rooms grey, the rest white; displays, when items are drawn, magenta. A bar at the bottom left is
 * five metres.
 */
export function drawLevel(p: Project, levelId: string, options: PlanPictureOptions = {}): PlanPicture {
  const walls = p.walls.filter((w) => w.levelId === levelId);
  const rooms = p.rooms.filter((r) => r.levelId === levelId);
  const pts = [...walls.flatMap((w) => [w.start, w.end]), ...rooms.flatMap((r) => r.polygon)];
  const minX = pts.length ? Math.min(...pts.map((q) => q.x)) : 0;
  const maxX = pts.length ? Math.max(...pts.map((q) => q.x)) : 10000;
  const minY = pts.length ? Math.min(...pts.map((q) => q.y)) : 0;
  const maxY = pts.length ? Math.max(...pts.map((q) => q.y)) : 10000;
  const margin = 44;
  const width = Math.round(options.widthPx ?? 1200);
  const spanX = Math.max(1000, maxX - minX);
  const spanY = Math.max(1000, maxY - minY);
  let s = (width - 2 * margin) / spanX;
  if (spanY * s + 2 * margin > 1600) s = (1600 - 2 * margin) / spanY;
  const height = Math.round(spanY * s + 2 * margin);
  const px = (q: Point): Point => ({ x: margin + (q.x - minX) * s, y: height - margin - (q.y - minY) * s });
  const c = new Canvas(width, height, PLAN_COLOURS.outside);

  // Inside the building and in no room: the floor a person would call unfinished. Pink rather than
  // grey, because grey is a service room, and a model reading the two as one would not see the gap.
  const shell = walls.filter(onShell).flatMap((w) => [w.start, w.end]);
  if (shell.length >= 2) {
    const a = px({ x: Math.min(...shell.map((q) => q.x)), y: Math.max(...shell.map((q) => q.y)) });
    const b = px({ x: Math.max(...shell.map((q) => q.x)), y: Math.min(...shell.map((q) => q.y)) });
    c.rect(a.x, a.y, b.x, b.y, PLAN_COLOURS.uncovered);
  }

  for (const r of rooms) {
    const fill =
      r.properties?.enclosure === "open"
        ? PLAN_COLOURS.open
        : CIRCULATION.has(r.purpose)
          ? PLAN_COLOURS.circulation
          : SERVICE.has(r.purpose)
            ? PLAN_COLOURS.service
            : PLAN_COLOURS.room;
    c.polygon(r.polygon.map(px), fill);
  }
  // Two rooms drawn over each other, in orange: the checker says "on top of each other over 15 m2",
  // and a model that cannot do the arithmetic can still see a block of orange where it went wrong.
  const box = (r: (typeof rooms)[number]) => ({
    x0: Math.min(...r.polygon.map((q) => q.x)),
    x1: Math.max(...r.polygon.map((q) => q.x)),
    y0: Math.min(...r.polygon.map((q) => q.y)),
    y1: Math.max(...r.polygon.map((q) => q.y)),
  });
  const boxes = rooms.map(box);
  for (let i = 0; i < boxes.length; i += 1)
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i] as ReturnType<typeof box>;
      const b = boxes[j] as ReturnType<typeof box>;
      const x0 = Math.max(a.x0, b.x0);
      const x1 = Math.min(a.x1, b.x1);
      const y0 = Math.max(a.y0, b.y0);
      const y1 = Math.min(a.y1, b.y1);
      if (x1 - x0 > 50 && y1 - y0 > 50) {
        const p0 = px({ x: x0, y: y1 });
        const p1 = px({ x: x1, y: y0 });
        c.rect(p0.x, p0.y, p1.x, p1.y, PLAN_COLOURS.overlap);
      }
    }

  if (options.items && options.sizes) {
    for (const it of p.items.filter((i) => i.levelId === levelId)) {
      const size = derive.itemSize(it, options.sizes);
      if (!size) continue;
      const fp = derive.itemFootprint(it, size).map(px);
      if (itemCategory(p, it) === "display") {
        c.polygon(fp, PLAN_COLOURS.display);
        continue;
      }
      for (let i = 0; i < fp.length; i += 1)
        c.band(fp[i] as Point, fp[(i + 1) % fp.length] as Point, 0.6, PLAN_COLOURS.item);
    }
  }

  const halfOf = (w: Wall): number => {
    const min = w.kind === "exterior" ? 2.2 : w.kind === "glass" ? (onShell(w) ? 2.2 : 1.4) : 1.2;
    return Math.max(min, (w.thickness * s) / 2);
  };
  for (const w of walls) {
    const colour =
      w.kind === "glass"
        ? PLAN_COLOURS.glass
        : w.kind === "exterior"
          ? PLAN_COLOURS.exterior
          : PLAN_COLOURS.interior;
    c.band(px(w.start), px(w.end), halfOf(w), colour);
  }

  const byId = new Map(walls.map((w) => [w.id, w]));
  for (const o of p.openings as Opening[]) {
    const w = byId.get(o.wallId);
    if (!w) continue;
    const len = derive.wallLength(w);
    if (len <= 0) continue;
    const iv = derive.openingAlongInterval(o, w);
    const dir = { x: (w.end.x - w.start.x) / len, y: (w.end.y - w.start.y) / len };
    const a = { x: w.start.x + dir.x * iv.from, y: w.start.y + dir.y * iv.from };
    const b = { x: w.start.x + dir.x * iv.to, y: w.start.y + dir.y * iv.to };
    const colour =
      o.kind === "window" ? PLAN_COLOURS.window : onShell(w) ? PLAN_COLOURS.entrance : PLAN_COLOURS.door;
    c.band(px(a), px(b), halfOf(w) + (o.kind === "window" ? 0.5 : 1.8), colour);
  }

  // numbers on the rooms, on a white box, at the middle of each room's bounds
  const scale = 3;
  for (const r of rooms) {
    const label = options.labels?.get(r.id);
    if (!label) continue;
    const b = r.polygon.map(px);
    const cx = (Math.min(...b.map((q) => q.x)) + Math.max(...b.map((q) => q.x))) / 2;
    const cy = (Math.min(...b.map((q) => q.y)) + Math.max(...b.map((q) => q.y))) / 2;
    const tw = c.textWidth(label, scale);
    const th = 5 * scale;
    c.rect(cx - tw / 2 - 3, cy - th / 2 - 3, cx + tw / 2 + 3, cy + th / 2 + 3, PLAN_COLOURS.label);
    c.rect(cx - tw / 2 - 2, cy - th / 2 - 2, cx + tw / 2 + 2, cy + th / 2 + 2, PLAN_COLOURS.room);
    c.text(label, Math.round(cx - tw / 2), Math.round(cy - th / 2), scale, PLAN_COLOURS.label);
  }

  // north arrow, top right, pointing where the project's north is; five metres, bottom left
  const rad = (p.meta.north * Math.PI) / 180;
  const nx = Math.cos(rad);
  const ny = -Math.sin(rad); // the picture's y runs down
  const ax = width - margin / 2 - 6;
  const ay = 22;
  c.polygon(
    [
      { x: ax + nx * 14, y: ay + ny * 14 },
      { x: ax - ny * 7 - nx * 4, y: ay + nx * 7 - ny * 4 },
      { x: ax + ny * 7 - nx * 4, y: ay - nx * 7 - ny * 4 },
    ],
    PLAN_COLOURS.label,
  );
  c.text("N", ax - 7 - nx * 20, ay - 7 - ny * 20, 3, PLAN_COLOURS.label);
  const bar = 5000 * s;
  c.rect(margin, height - 16, margin + bar, height - 12, PLAN_COLOURS.label);
  c.rect(margin, height - 22, margin + 2, height - 12, PLAN_COLOURS.label);
  c.rect(margin + bar - 2, height - 22, margin + bar, height - 12, PLAN_COLOURS.label);

  return {
    png: encodePng({ width, height, rgb: c.rgb }, (d) => deflateSync(d)),
    width,
    height,
    northUp: Math.abs((((p.meta.north % 360) + 360) % 360) - 90) < 1,
  };
}

/** What the caption says the colours are, for the model reading the picture. */
export const PLAN_KEY =
  "North is up. Walls: black is an outside wall, grey is plaster, blue is glass, and there is no line where two open rooms meet. Doors are red, an entrance from outside is green, windows are cyan. Open floor is pale yellow, corridors pale blue, service rooms grey, other rooms white, pink is floor inside the building that no room covers, and orange is two rooms drawn over each other; a magenta block is a display. The bar at the bottom left is 5 m.";
