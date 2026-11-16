// What a layout drawing says, whichever format carries it (ADR-013 D5): the shapes the plan draws, a
// schedule that names every kind of item once, a tag on each item that leads to its line, the height a
// fitter mounts a wall or ceiling item at, and the scale the sheet is drawn to.
import {
  type ItemShape,
  type PlanStructure,
  planBounds,
  planItems,
  planStructure,
  planZones,
  type ZoneShape,
} from "@fpv/engine";
import { derive, type Level, type Project, poly } from "@fpv/ir";

/** Paper sizes, portrait, in millimetres. */
export const PAPER_MM = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  A2: { w: 420, h: 594 },
  A1: { w: 594, h: 841 },
  A0: { w: 841, h: 1189 },
} as const;
export type PaperSize = keyof typeof PAPER_MM;

/** The scales a drawing is offered at, as the denominators of 1:n. */
export const STANDARD_SCALES = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000] as const;

/** What every drawing carries about where it came from (ADR-013 D2). */
export interface DrawingProvenance {
  projectName: string;
  appVersion: string;
  exportedAt: string;
  /** The newest catalog snapshot the project holds, or null when it holds none. */
  catalogSnapshotAt: string | null;
  /** Exported with `force` over validation errors: the sheet says DRAFT. */
  draft: boolean;
  validationErrors: number;
}

/** One kind of item in the schedule: what it is, how many, and where it is mounted. */
export interface ScheduleRow {
  tag: string;
  title: string;
  size: { w: number; d: number; h: number };
  mount: ItemShape["mount"];
  count: number;
  /** Distinct mount heights, lowest first; empty for items standing on the floor. */
  heights: number[];
}

/** One level as a sheet draws it. */
export interface LevelDrawing {
  level: Level;
  structure: PlanStructure;
  items: ItemShape[];
  zones: ZoneShape[];
  /** What the sheet frames: the whole level, or one room on it. */
  frame: poly.Rect | null;
  schedule: ScheduleRow[];
  /** The tag on each item, by item id. */
  tags: Map<string, string>;
}

/** A level's shapes, schedule and frame; `roomId` frames that room alone. */
export function levelDrawing(
  project: Project,
  levelId: string,
  sizes: derive.SizeSource,
  roomId: string | null = null,
): LevelDrawing {
  const level = project.levels.find((l) => l.id === levelId);
  if (!level) throw new Error(`no level ${levelId}`);
  const structure = planStructure(project, levelId);
  const items = planItems(project, levelId, sizes);
  const zones = planZones(project, levelId);
  const room = roomId ? project.rooms.find((r) => r.id === roomId) : null;
  const frame = room ? poly.bounds(room.polygon) : planBounds(structure, items, zones);
  const { rows, tags } = scheduleOf(room ? items.filter((it) => inRoom(it, room.polygon)) : items);
  return { level, structure, items, zones, frame, schedule: rows, tags };
}

function inRoom(it: ItemShape, ring: readonly { x: number; y: number }[]): boolean {
  const c = it.footprint.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4 }), { x: 0, y: 0 });
  return poly.containsPoint(ring, c);
}

/** A tag from a number: A to Z, then AA, AB and on, as drawing schedules count. */
export function tagName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Items grouped by what they are, their size and how they are mounted, each group tagged. Ordered by name
 * and then size, so the same project always tags the same way.
 */
export function scheduleOf(items: readonly ItemShape[]): { rows: ScheduleRow[]; tags: Map<string, string> } {
  const groups = new Map<string, { row: Omit<ScheduleRow, "tag">; ids: string[] }>();
  for (const it of items) {
    const key = `${it.title}|${it.size.w}x${it.size.d}x${it.size.h}|${it.mount}`;
    const g = groups.get(key) ?? {
      row: { title: it.title, size: it.size, mount: it.mount, count: 0, heights: [] },
      ids: [],
    };
    g.row.count += 1;
    g.ids.push(it.id);
    if (it.mountHeight !== null) {
      const h = Math.round(it.mountHeight);
      if (!g.row.heights.includes(h)) g.row.heights.push(h);
    }
    groups.set(key, g);
  }
  const ordered = [...groups.values()].sort(
    (a, b) =>
      a.row.title.localeCompare(b.row.title) ||
      a.row.size.w - b.row.size.w ||
      a.row.size.d - b.row.size.d ||
      a.row.size.h - b.row.size.h ||
      a.row.mount.localeCompare(b.row.mount),
  );
  const rows: ScheduleRow[] = [];
  const tags = new Map<string, string>();
  ordered.forEach((g, i) => {
    const tag = tagName(i);
    g.row.heights.sort((x, y) => x - y);
    rows.push({ tag, ...g.row });
    for (const id of g.ids) tags.set(id, tag);
  });
  return { rows, tags };
}

/** Millimetres grouped in thousands with a thin space, as drawings write them: 42 000. */
export function mm(v: number): string {
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * The note beside a mounted item: "CL 1450" for a wall item's centre line above the floor, "CLG 2700" for
 * a ceiling item. Null for anything standing on the floor or on something else.
 */
export function mountNote(it: ItemShape): string | null {
  if (it.mountHeight === null) return null;
  if (it.mount === "wall") return `CL ${mm(it.mountHeight)}`;
  if (it.mount === "ceiling") return `CLG ${mm(it.mountHeight)}`;
  return null;
}

/** A schedule row's mount, in words. */
export function mountWords(row: ScheduleRow): string {
  const heights =
    row.heights.length === 0
      ? ""
      : row.heights.length === 1
        ? ` ${mm(row.heights[0] as number)}`
        : ` ${mm(row.heights[0] as number)}-${mm(row.heights.at(-1) as number)}`;
  switch (row.mount) {
    case "wall":
      return `wall, CL${heights}`;
    case "ceiling":
      return `ceiling${heights}`;
    case "table":
      return "on a table";
    case "item":
      return "on another item";
    default:
      return "floor";
  }
}

/**
 * The largest standard scale (the smallest n in 1:n) at which a frame fits an area, both in millimetres;
 * or the scale asked for, with whether it fits.
 */
export function chooseScale(
  frame: { w: number; h: number },
  area: { w: number; h: number },
  wanted: number | null = null,
): { scale: number; fits: boolean } {
  const fitsAt = (s: number) => frame.w / s <= area.w && frame.h / s <= area.h;
  if (wanted) return { scale: wanted, fits: fitsAt(wanted) };
  for (const s of STANDARD_SCALES) if (fitsAt(s)) return { scale: s, fits: true };
  const last = STANDARD_SCALES.at(-1) as number;
  return { scale: last, fits: fitsAt(last) };
}

/** The newest catalog snapshot a project holds, as its provenance names it. */
export function catalogSnapshotOf(project: Project): string | null {
  let newest: string | null = null;
  for (const ref of Object.values(project.catalogRefs)) {
    const at = (ref as { snapshotAt?: unknown }).snapshotAt;
    if (typeof at === "string" && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/** The lines of a title block. */
export function titleLines(
  provenance: DrawingProvenance,
  level: Level,
  scaleText: string,
): { heading: string; lines: string[] } {
  const date = provenance.exportedAt.slice(0, 10);
  return {
    heading: provenance.projectName,
    lines: [
      level.name,
      scaleText,
      `Exported ${date}`,
      ...(provenance.catalogSnapshotAt ? [`Catalog ${provenance.catalogSnapshotAt.slice(0, 10)}`] : []),
      `floorplan-ai ${provenance.appVersion}`,
      ...(provenance.draft
        ? [
            `DRAFT: ${provenance.validationErrors} validation error${provenance.validationErrors === 1 ? "" : "s"}`,
          ]
        : []),
    ],
  };
}
