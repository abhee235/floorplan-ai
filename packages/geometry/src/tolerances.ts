// Tolerances from spec 05 section 1 (ADR-014 D1). All lengths in millimetres, angles in degrees.
export const TOL = {
  /** Joined corners closer than this become identical. */
  WELD: 0.1,
  /** Side-line intersection is skipped when the lines are within this angle of parallel. */
  PARALLEL_DEG: 0.01,
  /** Slope ratio test for near-parallel side lines. */
  PARALLEL_RATIO: 0.004,
  /** Mitre clamp: intersections farther than this factor times the larger thickness are discarded. */
  CLAMP_FACTOR: 2,
  /** Edges shorter than this are dropped. */
  DEGENERATE: 0.01,
  /** Maximum chord deviation when flattening arcs. */
  ARC_FLATTEN: 5,
  ARC_MIN_SEGMENTS: 4,
  /** Wall bottom and top nudges to avoid z-fighting. */
  LEVEL_SHIFT: 1,
  /** Room detection morphological close. */
  GAP_CLOSE_DEFAULT: 20,
  GAP_CLOSE_MAX: 100,
  /** Openings with a sill above this do not patch thresholds. */
  THRESHOLD_SILL_MAX: 0,
  /** Rings below this area are not rooms. */
  ROOM_MIN_AREA: 100_000,
} as const;
