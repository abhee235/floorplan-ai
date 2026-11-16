// A picture's scale from things of known size (ADR-030 D6). The model measures; this does the arithmetic.
//
// Live copies read a picture without dimensions at a scale 5 to 42 per cent off, usually from one door or
// one bed taken at a single guessed size. Each thing measured gives a range of millimetres per pixel,
// not a number: a door leaf is 800 to 1000 mm, so a 45-pixel leaf says 17.8 to 22.2 mm/px. The scale
// is where most of those ranges agree, and a measurement outside it is named, because it is either
// misread or not what it looked like.

/** Real sizes, in mm, of things plans draw, by the one dimension named. */
export const KNOWN_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  door: [800, 1000], // one leaf, the width of the opening it swings in
  "double-door": [1400, 1900],
  desk: [1200, 1800], // length
  "desk-depth": [600, 800],
  chair: [450, 600], // seat width
  "single-bed": [900, 1000], // width
  "double-bed": [1350, 1800], // width
  "bed-length": [1900, 2200],
  sofa: [1800, 2400], // a three-seat length
  "sofa-depth": [800, 1000],
  "counter-depth": [550, 650],
  "stair-tread": [250, 300],
  wc: [650, 750], // length, front to back
  bath: [1500, 1800], // length
  "meeting-chair-pitch": [600, 800], // centre to centre along a table
  bed: [900, 1800], // width, when it is not clear whether it is single or double
};

/** The everyday words for them; a live run wrote "bed", and its script stopped on it. */
const ALSO: Readonly<Record<string, string>> = {
  "door-leaf": "door",
  toilet: "wc",
  bathtub: "bath",
  "desk-length": "desk",
  "kitchen-counter": "counter-depth",
  counter: "counter-depth",
};

function sizeOf(kind: string): readonly [number, number] | undefined {
  const k = kind
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return KNOWN_SIZES[k] ?? KNOWN_SIZES[ALSO[k] ?? ""];
}

export interface Measured {
  kind?: string;
  /** Its size in the picture, in pixels. */
  px: number;
  /** Its real size when the kind is not one of KNOWN_SIZES: [least, most] mm. */
  mm?: [number, number];
  /** What the model calls it, echoed back. */
  label?: string;
}

export interface ScaleEstimate {
  /** The middle of the range most measurements agree on, or null when none was usable. */
  mmPerPx: number | null;
  /** That range. */
  low: number | null;
  high: number | null;
  /** The measurements that agree, and those that do not, with the scale each alone would give. */
  agree: { label: string; range: [number, number] }[];
  outliers: { label: string; range: [number, number] }[];
  note: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function scaleFrom(measured: readonly Measured[]): ScaleEstimate {
  if (!Array.isArray(measured) || measured.length === 0)
    throw new Error(
      'give what you measured: scaleFrom([{ kind: "door", px: 45 }, { kind: "desk", px: 70 }])',
    );
  const ranges = measured.map((m, i) => {
    const label = m.label ?? m.kind ?? `#${i + 1}`;
    const mm = m.mm ?? (m.kind ? sizeOf(m.kind) : undefined);
    if (!mm)
      throw new Error(
        `"${m.kind ?? "?"}" has no known size; give mm: [least, most], or one of ${Object.keys(KNOWN_SIZES).join(", ")}`,
      );
    if (!(m.px > 0)) throw new Error(`${label}: px is its size in the picture, a number above 0`);
    return { label, range: [mm[0] / m.px, mm[1] / m.px] as [number, number] };
  });
  // The point covered by the most ranges, found by sweeping their ends.
  const ends = ranges.flatMap((r) => [r.range[0], r.range[1]]).sort((a, b) => a - b);
  let best = { count: 0, at: 0 };
  for (let i = 0; i < ends.length; i += 1) {
    const a = ends[i] as number;
    const b = (ends[i + 1] ?? a) as number;
    const mid = (a + b) / 2;
    const count = ranges.filter((r) => r.range[0] <= mid && mid <= r.range[1]).length;
    if (count > best.count) best = { count, at: mid };
  }
  const agree = ranges.filter((r) => r.range[0] <= best.at && best.at <= r.range[1]);
  const outliers = ranges.filter((r) => !agree.includes(r));
  const low = Math.max(...agree.map((r) => r.range[0]));
  const high = Math.min(...agree.map((r) => r.range[1]));
  const round = (r: { label: string; range: [number, number] }) => ({
    label: r.label,
    range: [r2(r.range[0]), r2(r.range[1])] as [number, number],
  });
  const note =
    ranges.length === 1
      ? "one measurement only: measure two or three more things of known size and check they agree"
      : agree.length === 1
        ? "no two measurements agree: re-measure, or check what each one really is"
        : outliers.length
          ? `${agree.length} of ${ranges.length} agree; look again at ${outliers.map((o) => o.label).join(", ")}`
          : `all ${ranges.length} agree`;
  return {
    mmPerPx: r2((low + high) / 2),
    low: r2(low),
    high: r2(high),
    agree: agree.map(round),
    outliers: outliers.map(round),
    note,
  };
}
