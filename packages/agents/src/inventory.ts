// Did a run that copied a picture copy all of it? (ADR-030 D6, measured on 2026-09-24.)
//
// A live run measured an office picture with run_code, drew the walls, placed 15 of the 91 pieces of
// furniture and 1 of the 15 openings, wrote in its own answer what was missing, and finished. Nothing held
// it to what it had measured. So the model writes what it measured into its notes as one line, and before
// the run may end, that line is compared with what the project holds. Bounded like every gate: it asks,
// and a model that has a reason to stop says so and is believed.

import type { Project } from "@fpv/ir";

export interface Inventory {
  walls?: number;
  doors?: number;
  windows?: number;
  passages?: number;
  rooms?: number;
  items?: number;
}

const KEYS = ["walls", "doors", "windows", "passages", "rooms", "items"] as const;

/** The inventory line in the notes: `INVENTORY walls=9 doors=5 windows=9 rooms=7 items=91`, or null. */
export function inventoryFrom(notes: string): Inventory | null {
  const line = /INVENTORY\b[:\s]*([^\n]*)/i.exec(notes)?.[1];
  if (!line) return null;
  const out: Inventory = {};
  for (const k of KEYS) {
    // "items=~50", "items: about 50" and "items=50+" are counts too. A live run wrote the first, the
    // count went unread, and it finished with none of the ninety-one pieces placed.
    const m = new RegExp(`\\b${k}\\s*[=:]\\s*(?:~|≈|about\\s+|approx\\.?\\s+|c\\.\\s*)?(\\d+)`, "i").exec(
      line,
    );
    if (m) out[k] = Number(m[1]);
  }
  return Object.keys(out).length ? out : null;
}

/** What the project holds, counted the way the inventory is written. */
export function builtCounts(p: Pick<Project, "walls" | "openings" | "rooms" | "items">): Required<Inventory> {
  return {
    walls: p.walls.length,
    doors: p.openings.filter((o) => o.kind === "door").length,
    windows: p.openings.filter((o) => o.kind === "window").length,
    passages: p.openings.filter((o) => o.kind === "passage").length,
    rooms: p.rooms.length,
    items: p.items.length,
  };
}

/** Each kind the project has fewer of than `share` of what was measured, as "doors 1 of 5". */
export function inventoryGap(measured: Inventory, built: Required<Inventory>, share = 0.9): string[] {
  const gaps: string[] = [];
  for (const k of KEYS) {
    const want = measured[k];
    if (want === undefined || want === 0) continue;
    if (built[k] < Math.ceil(want * share)) gaps.push(`${k} ${built[k]} of ${want}`);
  }
  return gaps;
}

/** How many times a run is held back before it is believed. */
export const COPY_GATE_FIRINGS = 3;

/**
 * What to tell a model that is about to finish a copy, or null to let it finish. `asked` is how many times
 * it has been told already.
 */
export function copyReminder(notes: string, built: Required<Inventory>, asked: number): string | null {
  if (asked >= COPY_GATE_FIRINGS) return null;
  const measured = inventoryFrom(notes);
  if (!measured)
    return asked === 0
      ? "You copied a picture. Before you answer, write what you measured into notes as one line — INVENTORY walls=N doors=N windows=N passages=N rooms=N items=N — so what you built can be checked against it."
      : null;
  const gaps = inventoryGap(measured, built);
  if (!gaps.length) return null;
  return `What you built is short of what you measured in the picture: ${gaps.join(", ")}. Carry on drawing them from your measurements — run_code still has your variables — or, if some are deliberately left out, say which and why in your answer.`;
}
