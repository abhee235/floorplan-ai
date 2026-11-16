// Plans for the picture evals (ADR-030, and the owner's rule of 2026-09-24: measure every agent change on
// several pictures, with one held out). Each plan is a spec in millimetres; build.ts turns it into a picture
// in a drawing style and into the reference project the run is scored against, so the two cannot disagree.
//
// They are ours, drawn by code, so they can live in a public repository. They differ on purpose in what a
// reader has to work out: how walls are drawn, how doors and windows are drawn, what furniture there is,
// whether labels are typed or handwritten. None of them is the picture the harness was first tuned on.

export type Style = "double" | "hatched" | "sketch";
export type Pt = [number, number];

export interface WallSpec {
  a: Pt;
  b: Pt;
  thick: number;
  kind?: "exterior" | "interior" | "glass";
}

export interface OpeningSpec {
  /** Index into walls. */
  wall: number;
  /** Centre, in mm from the wall's start. */
  at: number;
  width: number;
  kind: "door" | "double" | "window" | "passage";
  /** Door hinge at the wall's start or end side of the gap; a double door hinges at both. */
  hinge?: "start" | "end";
  /** The side the leaf swings to: left (+1) or right (-1) of the wall's direction. */
  side?: 1 | -1;
}

export interface RoomSpec {
  name: string;
  polygon: Pt[];
  label: Pt;
}

export type ItemKind = "bed" | "sofa" | "table" | "desk" | "chair" | "box" | "round" | "plant";

export interface ItemSpec {
  kind: ItemKind;
  at: Pt;
  w: number;
  d: number;
  /** Degrees, counter-clockwise; 0 faces south (the back to the north), as place_item has it. */
  rot?: number;
}

export interface PlanSpec {
  name: string;
  title: string;
  style: Style;
  /** mm per pixel of the rendered picture. */
  scale: number;
  size: Pt;
  heldOut?: boolean;
  walls: WallSpec[];
  openings: OpeningSpec[];
  rooms: RoomSpec[];
  items: ItemSpec[];
}

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** A two-bedroom flat, walls drawn as double lines. */
const flat: PlanSpec = {
  name: "flat-double",
  title: "A two-bedroom flat drawn with double-line walls",
  style: "double",
  scale: 15,
  size: [12000, 9000],
  walls: [
    { a: [0, 0], b: [12000, 0], thick: 250, kind: "exterior" }, // 0 south
    { a: [12000, 0], b: [12000, 9000], thick: 250, kind: "exterior" }, // 1 east
    { a: [12000, 9000], b: [0, 9000], thick: 250, kind: "exterior" }, // 2 north
    { a: [0, 9000], b: [0, 0], thick: 250, kind: "exterior" }, // 3 west
    { a: [0, 5000], b: [12000, 5000], thick: 120 }, // 4 hall north
    { a: [6000, 5000], b: [6000, 9000], thick: 120 }, // 5 living | kitchen
    { a: [0, 3800], b: [4500, 3800], thick: 120 }, // 6 bedroom 1 north
    { a: [7000, 3800], b: [12000, 3800], thick: 120 }, // 7 bedroom 2 north
    { a: [4500, 0], b: [4500, 3800], thick: 120 }, // 8 bedroom 1 | bathroom
    { a: [7000, 0], b: [7000, 3800], thick: 120 }, // 9 bathroom | bedroom 2
    { a: [4500, 2800], b: [7000, 2800], thick: 120 }, // 10 bathroom north
  ],
  openings: [
    { wall: 3, at: 4600, width: 1000, kind: "door", hinge: "start", side: 1 }, // the way in, west wall
    { wall: 4, at: 3000, width: 900, kind: "door", hinge: "start", side: 1 },
    { wall: 4, at: 7500, width: 1200, kind: "passage" },
    { wall: 4, at: 10500, width: 1000, kind: "passage" },
    { wall: 6, at: 3500, width: 900, kind: "door", hinge: "end", side: -1 },
    { wall: 10, at: 1250, width: 800, kind: "door", hinge: "start", side: -1 },
    { wall: 7, at: 1000, width: 900, kind: "door", hinge: "start", side: -1 },
    { wall: 2, at: 9000, width: 1500, kind: "window" }, // living
    { wall: 2, at: 4500, width: 1200, kind: "window" }, // kitchen
    { wall: 2, at: 1500, width: 1500, kind: "window" }, // dining
    { wall: 0, at: 2200, width: 1500, kind: "window" }, // bedroom 1
    { wall: 0, at: 5750, width: 600, kind: "window" }, // bathroom
    { wall: 0, at: 9500, width: 1500, kind: "window" }, // bedroom 2
    { wall: 1, at: 7000, width: 1200, kind: "window" }, // dining
  ],
  rooms: [
    { name: "Living room", polygon: rect(0, 5000, 6000, 9000), label: [3000, 7500] },
    { name: "Kitchen", polygon: rect(6000, 5000, 9000, 9000), label: [7500, 6600] },
    { name: "Dining", polygon: rect(9000, 5000, 12000, 9000), label: [10500, 8300] },
    { name: "Hall", polygon: rect(0, 3800, 12000, 5000), label: [6000, 4400] },
    { name: "Bedroom 1", polygon: rect(0, 0, 4500, 3800), label: [2200, 3000] },
    { name: "Bathroom", polygon: rect(4500, 0, 7000, 2800), label: [5750, 1500] },
    { name: "Bedroom 2", polygon: rect(7000, 0, 12000, 3800), label: [9500, 3100] },
  ],
  items: [
    { kind: "bed", at: [2200, 1150], w: 1600, d: 2000, rot: 180 },
    { kind: "box", at: [350, 2600], w: 600, d: 1800 },
    { kind: "bed", at: [9300, 1100], w: 1400, d: 2000, rot: 180 },
    { kind: "desk", at: [11300, 2900], w: 1200, d: 600, rot: 90 },
    { kind: "chair", at: [10650, 2900], w: 500, d: 500, rot: 90 },
    { kind: "sofa", at: [2500, 5600], w: 2200, d: 900, rot: 180 },
    { kind: "table", at: [2500, 6800], w: 1100, d: 600 },
    { kind: "box", at: [2500, 8650], w: 1600, d: 400 },
    { kind: "chair", at: [4900, 6800], w: 800, d: 800, rot: 270 },
    { kind: "box", at: [7500, 8570], w: 2800, d: 600 },
    { kind: "box", at: [6450, 5500], w: 700, d: 700 },
    { kind: "round", at: [10500, 6900], w: 1200, d: 1200 },
    { kind: "chair", at: [9650, 6900], w: 450, d: 450, rot: 90 },
    { kind: "chair", at: [11350, 6900], w: 450, d: 450, rot: 270 },
    { kind: "chair", at: [10500, 6050], w: 450, d: 450, rot: 180 },
    { kind: "chair", at: [10500, 7750], w: 450, d: 450 },
    { kind: "box", at: [4900, 1400], w: 700, d: 1700 },
    { kind: "box", at: [6550, 500], w: 400, d: 700 },
    { kind: "box", at: [6500, 2450], w: 500, d: 400 },
    { kind: "plant", at: [11550, 4400], w: 500, d: 500 },
  ],
};

/** A small office, walls hatched, with a double door and a glass partition. */
const office: PlanSpec = {
  name: "office-hatched",
  title: "A small office drawn with hatched walls",
  style: "hatched",
  scale: 17.5,
  size: [14000, 8000],
  walls: [
    { a: [0, 0], b: [14000, 0], thick: 300, kind: "exterior" }, // 0 south
    { a: [14000, 0], b: [14000, 8000], thick: 300, kind: "exterior" }, // 1 east
    { a: [14000, 8000], b: [0, 8000], thick: 300, kind: "exterior" }, // 2 north
    { a: [0, 8000], b: [0, 0], thick: 300, kind: "exterior" }, // 3 west
    { a: [4500, 0], b: [4500, 4500], thick: 120 }, // 4 office east
    { a: [4500, 4500], b: [4500, 8000], thick: 80, kind: "glass" }, // 5 meeting east (glass)
    { a: [0, 4500], b: [4500, 4500], thick: 120 }, // 6 office | meeting
  ],
  openings: [
    { wall: 0, at: 9000, width: 1800, kind: "double", side: 1 }, // the way in
    { wall: 5, at: 1000, width: 900, kind: "door", hinge: "start", side: 1 },
    { wall: 4, at: 3500, width: 900, kind: "door", hinge: "end", side: -1 },
    { wall: 2, at: 11750, width: 1800, kind: "window" }, // meeting
    { wall: 2, at: 7000, width: 1800, kind: "window" },
    { wall: 2, at: 4500, width: 1800, kind: "window" },
    { wall: 0, at: 2250, width: 1500, kind: "window" }, // office
    { wall: 1, at: 2500, width: 1500, kind: "window" },
    { wall: 1, at: 5500, width: 1500, kind: "window" },
  ],
  rooms: [
    { name: "Meeting room", polygon: rect(0, 4500, 4500, 8000), label: [2250, 7500] },
    { name: "Office", polygon: rect(0, 0, 4500, 4500), label: [2250, 3800] },
    { name: "Open plan", polygon: rect(4500, 0, 11000, 8000), label: [7800, 4600] },
    { name: "Kitchenette", polygon: rect(11000, 5500, 14000, 8000), label: [12500, 5750] },
    { name: "Work area", polygon: rect(11000, 0, 14000, 5500), label: [12500, 4500] },
  ],
  items: [
    { kind: "table", at: [2250, 6250], w: 2400, d: 1100 },
    ...[1450, 2250, 3050].flatMap((x): ItemSpec[] => [
      { kind: "chair", at: [x, 5400], w: 500, d: 500, rot: 180 },
      { kind: "chair", at: [x, 7100], w: 500, d: 500 },
    ]),
    { kind: "desk", at: [2250, 1500], w: 1600, d: 800 },
    { kind: "chair", at: [2250, 2250], w: 550, d: 550 },
    { kind: "box", at: [2250, 4150], w: 1200, d: 500 },
    ...[7500, 11800].flatMap((cx): ItemSpec[] => [
      { kind: "desk", at: [cx - 700, 2150], w: 1400, d: 700 },
      { kind: "desk", at: [cx + 700, 2150], w: 1400, d: 700 },
      { kind: "desk", at: [cx - 700, 2850], w: 1400, d: 700 },
      { kind: "desk", at: [cx + 700, 2850], w: 1400, d: 700 },
      { kind: "chair", at: [cx - 700, 1450], w: 500, d: 500, rot: 180 },
      { kind: "chair", at: [cx + 700, 1450], w: 500, d: 500, rot: 180 },
      { kind: "chair", at: [cx - 700, 3550], w: 500, d: 500 },
      { kind: "chair", at: [cx + 700, 3550], w: 500, d: 500 },
    ]),
    { kind: "box", at: [12600, 7550], w: 2400, d: 600 },
    { kind: "round", at: [12500, 6500], w: 900, d: 900 },
    { kind: "chair", at: [11850, 6500], w: 450, d: 450, rot: 90 },
    { kind: "chair", at: [13150, 6500], w: 450, d: 450, rot: 270 },
    { kind: "plant", at: [4950, 7550], w: 500, d: 500 },
    { kind: "plant", at: [13550, 450], w: 500, d: 500 },
  ],
};

/** A studio flat drawn by hand. Held out: never tuned against. */
const studio: PlanSpec = {
  name: "studio-sketch",
  title: "A studio flat drawn as a hand sketch",
  style: "sketch",
  scale: 12,
  size: [9000, 7000],
  heldOut: true,
  walls: [
    { a: [0, 0], b: [9000, 0], thick: 200, kind: "exterior" }, // 0 south
    { a: [9000, 0], b: [9000, 7000], thick: 200, kind: "exterior" }, // 1 east
    { a: [9000, 7000], b: [0, 7000], thick: 200, kind: "exterior" }, // 2 north
    { a: [0, 7000], b: [0, 0], thick: 200, kind: "exterior" }, // 3 west
    { a: [6000, 0], b: [6000, 3000], thick: 100 }, // 4 bathroom west
    { a: [6000, 3000], b: [9000, 3000], thick: 100 }, // 5 bathroom north
  ],
  openings: [
    { wall: 2, at: 4500, width: 900, kind: "door", hinge: "start", side: 1 }, // the way in
    { wall: 5, at: 1500, width: 800, kind: "door", hinge: "start", side: -1 },
    { wall: 3, at: 3500, width: 1800, kind: "window" },
    { wall: 2, at: 7400, width: 1500, kind: "window" },
    { wall: 0, at: 2500, width: 1200, kind: "window" },
  ],
  rooms: [
    { name: "Living", polygon: rect(0, 3500, 6000, 7000), label: [3000, 6500] },
    { name: "Sleeping", polygon: rect(0, 0, 6000, 3500), label: [3500, 3000] },
    { name: "Kitchen", polygon: rect(6000, 3000, 9000, 7000), label: [7400, 4000] },
    { name: "Bath", polygon: rect(6000, 0, 9000, 3000), label: [7500, 1700] },
  ],
  items: [
    { kind: "bed", at: [1300, 1500], w: 1600, d: 2000, rot: 90 },
    { kind: "sofa", at: [3000, 6100], w: 2000, d: 850 },
    { kind: "table", at: [3000, 4900], w: 1000, d: 500 },
    { kind: "table", at: [4700, 2000], w: 900, d: 900 },
    { kind: "chair", at: [4700, 1300], w: 450, d: 450, rot: 180 },
    { kind: "chair", at: [4700, 2700], w: 450, d: 450 },
    { kind: "box", at: [8600, 5100], w: 600, d: 2600 },
    { kind: "box", at: [8550, 6600], w: 700, d: 600 },
    { kind: "box", at: [8400, 600], w: 900, d: 900 },
    { kind: "box", at: [6450, 500], w: 450, d: 700 },
    { kind: "box", at: [8600, 2200], w: 500, d: 400, rot: 90 },
  ],
};

export const PLANS: readonly PlanSpec[] = [flat, office, studio];
