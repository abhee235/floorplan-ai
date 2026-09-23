// Tidying a design's arithmetic (ADR-028 D10): the smallest moves that make a drawn plan buildable.
//
// The architect decides what goes where; that is D1 and it stands. What it cannot reliably do is the
// arithmetic: across five live runs on a local model, the errors it could not clear were almost
// always two rooms overlapping by a few hundred millimetres or a room running past the shell, and it
// spent its rounds re-sending the same rectangles. The checker's hints carry the exact numbers and
// it still did not apply them.
//
// So this moves rooms, on request, by the least it can: every room clamped inside the building, then
// overlapping pairs pushed apart along whichever axis they overlap least, the smaller room moving.
// The arrangement -- which room is on which side of which -- is what the model decided and what the
// least move keeps. Everything it moves is reported, so the model can see what its plan became.
import { type Design, type DesignRect, type DesignRoom, enclosureOf } from "@fpv/ir";

export interface TidyResult {
  design: Design;
  /** What moved, in words, one line each. */
  moves: string[];
  /** Overlaps left after the passes, if any pair could not be parted. */
  unresolved: string[];
}

const area = (r: DesignRect) => r.w * r.d;
const overlapOf = (a: DesignRect, b: DesignRect) => ({
  x: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
  y: Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y),
});

/** Round to the millimetre; a design is written in whole millimetres. */
const mm = (n: number) => Math.round(n);

/**
 * Move rooms the least that makes the plan buildable: all inside the shell, none on top of another.
 *
 * Passes, because moving one room can push it into the next; eight is enough for the plans a model
 * writes, and what is left over is reported rather than shuffled forever.
 */
/**
 * The open zone cut back so it no longer covers the room, on the side that costs the least floor.
 *
 * Null when the cut would leave a strip too narrow to be a zone; then the room moves instead.
 */
function cutClear(
  zone: DesignRect,
  room: DesignRect,
  wall: number,
  over: { x: number; y: number },
): DesignRect | null {
  const least = 2000;
  const options: DesignRect[] = [];
  if (over.x <= over.y) {
    options.push({ ...zone, w: room.x - wall - zone.x });
    const from = room.x + room.w + wall;
    options.push({ ...zone, x: from, w: zone.x + zone.w - from });
  } else {
    options.push({ ...zone, d: room.y - wall - zone.y });
    const from = room.y + room.d + wall;
    options.push({ ...zone, y: from, d: zone.y + zone.d - from });
  }
  const fits = options.filter((o) => o.w >= least && o.d >= least);
  // the cut that keeps the most floor
  return fits.sort((p, q) => q.w * q.d - p.w * p.d)[0] ?? null;
}

export function tidyDesign(design: Design, passes = 8): TidyResult {
  const { shell } = design;
  const wall = shell.interiorWallMm;
  const lo = { x: shell.x + shell.wallMm, y: shell.y + shell.wallMm };
  const hi = { x: shell.x + shell.w - shell.wallMm, y: shell.y + shell.d - shell.wallMm };
  const byKey = new Map<string, DesignRoom>(design.rooms.map((r) => [r.key, r]));
  const rects = new Map<string, DesignRect>(design.rooms.map((r) => [r.key, { ...r.rect }]));
  const was = new Map<string, DesignRect>(design.rooms.map((r) => [r.key, { ...r.rect }]));
  const moves: string[] = [];

  /** Inside the building: shrunk first if it cannot fit, then slid in. */
  const clamp = (rect: DesignRect): DesignRect => {
    const w = Math.min(rect.w, hi.x - lo.x);
    const d = Math.min(rect.d, hi.y - lo.y);
    return {
      w: mm(w),
      d: mm(d),
      x: mm(Math.min(Math.max(rect.x, lo.x), hi.x - w)),
      y: mm(Math.min(Math.max(rect.y, lo.y), hi.y - d)),
    };
  };

  for (const [key, rect] of rects) rects.set(key, clamp(rect));

  for (let pass = 0; pass < passes; pass += 1) {
    let moved = false;
    const keys = [...rects.keys()];
    for (let i = 0; i < keys.length; i += 1)
      for (let j = i + 1; j < keys.length; j += 1) {
        const aKey = keys[i] as string;
        const bKey = keys[j] as string;
        const a = rects.get(aKey) as DesignRect;
        const b = rects.get(bKey) as DesignRect;
        const over = overlapOf(a, b);
        if (over.x <= 0 || over.y <= 0) continue;
        // An open zone drawn over a room: the room is where the architect meant it, and the zone is
        // the floor around it, so the zone gives way. Moving the room instead threw a reception
        // thirty metres across the building to get out from under the open floor.
        const openA = enclosureOf(byKey.get(aKey) as DesignRoom) === "open";
        const openB = enclosureOf(byKey.get(bKey) as DesignRoom) === "open";
        // Which of the two is floor to be cut: the open one, or the larger where both are open --
        // two open zones over each other are both the floor, and moving either moves a room the
        // architect placed. A reception drawn as an open zone inside the desks was thrown nineteen
        // metres east because this only looked at one open room against an enclosed one.
        const giver =
          openA && openB
            ? area(a) >= area(b)
              ? ([aKey, a, b] as const)
              : ([bKey, b, a] as const)
            : openA
              ? ([aKey, a, b] as const)
              : openB
                ? ([bKey, b, a] as const)
                : null;
        if (giver) {
          const cut = cutClear(giver[1], giver[2], wall, over);
          if (cut) {
            rects.set(giver[0], clamp(cut));
            moved = true;
            continue;
          }
        }
        // the smaller room gives way: the bigger one is more often the floor everything sits around
        const [big, small, smallKey] = area(a) >= area(b) ? ([a, b, bKey] as const) : ([b, a, aKey] as const);
        const alongX = over.x <= over.y;
        const next = { ...small };
        if (alongX) {
          const toRight = big.x + big.w + wall;
          const toLeft = big.x - wall - small.w;
          const right = { ...small, x: toRight };
          const left = { ...small, x: toLeft };
          const fits = (r: DesignRect) => r.x >= lo.x && r.x + r.w <= hi.x;
          const pick = fits(right) && (!fits(left) || toRight - small.x <= small.x - toLeft) ? right : left;
          next.x = mm(pick.x);
        } else {
          const up = big.y + big.d + wall;
          const down = big.y - wall - small.d;
          const north = { ...small, y: up };
          const south = { ...small, y: down };
          const fits = (r: DesignRect) => r.y >= lo.y && r.y + r.d <= hi.y;
          const pick = fits(north) && (!fits(south) || up - small.y <= small.y - down) ? north : south;
          next.y = mm(pick.y);
        }
        rects.set(smallKey, clamp(next));
        moved = true;
      }
    if (!moved) break;
  }

  const unresolved: string[] = [];
  const keys = [...rects.keys()];
  for (let i = 0; i < keys.length; i += 1)
    for (let j = i + 1; j < keys.length; j += 1) {
      const a = rects.get(keys[i] as string) as DesignRect;
      const b = rects.get(keys[j] as string) as DesignRect;
      const over = overlapOf(a, b);
      if (over.x > 0 && over.y > 0)
        unresolved.push(
          `${keys[i]} and ${keys[j]} still share ${Math.round((over.x * over.y) / 1e6)} m2; the building may be too small for these rooms`,
        );
    }

  for (const [key, rect] of rects) {
    const before = was.get(key) as DesignRect;
    const dx = rect.x - before.x;
    const dy = rect.y - before.y;
    const dw = rect.w - before.w;
    const dd = rect.d - before.d;
    if (dx === 0 && dy === 0 && dw === 0 && dd === 0) continue;
    const said: string[] = [];
    if (dx) said.push(`${Math.abs(dx)} mm ${dx > 0 ? "east" : "west"}`);
    if (dy) said.push(`${Math.abs(dy)} mm ${dy > 0 ? "north" : "south"}`);
    if (dw || dd) said.push(`and is now ${rect.w} by ${rect.d}`);
    moves.push(`${key} moved ${said.join(", ")}`);
  }

  const rooms: DesignRoom[] = design.rooms.map((r) => ({ ...r, rect: rects.get(r.key) as DesignRect }));
  return { design: { ...design, rooms }, moves, unresolved };
}
