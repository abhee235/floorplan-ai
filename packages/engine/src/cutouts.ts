// Cut-out shapes for openings (ADR-014 D7 step 3; O-069, O-075, O-080): the product snapshot's cut-out path
// and embed rectangle as rings in the unit square, y down. Null means the plain rectangle.
import { cutOutRings, cutOutTolerance, effectiveCutOutPath } from "@fpv/catalog";
import type { Opening, Point, Project } from "@fpv/ir";

export type CutOutSource = (opening: Opening) => Point[][] | null;

/** The opening part of a product or product snapshot, as far as cutting is concerned. */
export interface CutOutSpec {
  cutOutPath?: string | null;
  embed?: { width?: number; left?: number; height?: number; top?: number };
}

const UNIT: Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

/**
 * A cut-out source over a product lookup. Parsed paths are cached by path and tolerance, so openings that
 * share a product and size parse once (O-080); `stats.parses` counts the parses.
 */
export function cutOutSource(
  lookup: (productId: string) => CutOutSpec | null | undefined,
): CutOutSource & { stats: { parses: number } } {
  const cache = new Map<string, Point[][] | null>();
  const stats = { parses: 0 };
  const source = (o: Opening): Point[][] | null => {
    if (!o.productId) return null;
    const spec = lookup(o.productId);
    if (!spec) return null;
    const e = {
      width: spec.embed?.width ?? 1,
      left: spec.embed?.left ?? 0,
      height: spec.embed?.height ?? 1,
      top: spec.embed?.top ?? 0,
    };
    // C-050, O-079 reversed: an invalid path cuts the rectangle, never an offset square
    const path = effectiveCutOutPath(spec.cutOutPath ?? null);
    const subRect = e.width !== 1 || e.left !== 0 || e.height !== 1 || e.top !== 0;
    if (!path && !subRect) return null;
    let rings: Point[][] = [UNIT];
    if (path) {
      const tol = cutOutTolerance(o.width * e.width, o.height * e.height);
      const key = `${tol}|${path}`;
      if (!cache.has(key)) {
        stats.parses += 1;
        cache.set(key, cutOutRings(path, tol));
      }
      const parsed = cache.get(key);
      if (parsed && parsed.length > 0) rings = parsed;
    }
    if (!subRect) return rings;
    // O-075: the hole sits in a sub-rectangle of the opening's box
    return rings.map((r) => r.map((p) => ({ x: e.left + p.x * e.width, y: e.top + p.y * e.height })));
  };
  return Object.assign(source, { stats });
}

/** Cut-out source backed by a project's catalog snapshots. */
export function snapshotCutOuts(project: Project): CutOutSource & { stats: { parses: number } } {
  return cutOutSource(
    (id) => (project.catalogRefs[id] as { opening?: CutOutSpec | null } | undefined)?.opening ?? null,
  );
}
