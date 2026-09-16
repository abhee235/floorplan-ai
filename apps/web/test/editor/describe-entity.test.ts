// describeEntity against a real project, not a hand-built stub.
//
// This is the function that carries every schema assumption in selection.ts — which field names exist,
// which are nullable, what a thing is called. A stub would only assert the shape I already believed, and
// that belief was wrong once already: Item has no `name` field, and the first version of itemTitle read
// one. The six-wall fixture is the same project the render tests use.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, type Ctx } from "@fpv/commands";
import { derive, Project, type Project as ProjectT, sequentialIdGenerator, WallKind } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  describeEntity,
  type EditCommand,
  type EditOutcome,
  type Fact,
  THICKNESS_RANGE,
} from "../../src/editor/selection.js";
import { formatMm } from "../../src/editor/status.js";
import { WALL_KINDS } from "../../src/editor/tools.js";

const fixtureDir = fileURLToPath(new URL("../../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = (): ProjectT => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const ctx: Ctx = { ids: sequentialIdGenerator(700), now: () => "2026-09-15T00:00:00.000Z" };
const L = "level_000000";
const NARROW = "\u202f";
const W1 = "wall_000001"; // (0,0) to (8000,0); its start joins wall 6's end, its end joins wall 2's start

/** Runs a command through the real reducer, as the host would. */
function run(p: ProjectT, command: unknown): { project: ProjectT; updated: { type: string; id: string }[] } {
  const r = apply(p, command, ctx);
  if (!r.ok) throw new Error(r.error.message);
  return { project: r.project, updated: r.changes.updated };
}

function rowOf(p: ProjectT, id: string, label: string): Fact {
  const fact = describeEntity(p, id)?.facts.find((f) => f.label === label);
  if (!fact) throw new Error(`no ${label} row for ${id}`);
  return fact;
}

/** What typing `text` into a row asks the host to do; throws unless that is a command. */
function typed(p: ProjectT, id: string, label: string, text: string): EditCommand {
  const outcome = rowOf(p, id, label).edit?.(text);
  if (!outcome?.ok || !outcome.command) throw new Error(`expected a command, got ${JSON.stringify(outcome)}`);
  return outcome.command;
}

const wallOf = (p: ProjectT, id: string) => p.walls.find((w) => w.id === id) as ProjectT["walls"][number];

function withRoom(): ProjectT {
  const r = apply(
    fixture(),
    { type: "room.create", payload: { levelId: L, atPoint: { x: 2000, y: 2000 } } },
    ctx,
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

describe("describing a selected entity", () => {
  it("describes a wall by its kind, its ends, its length and its thickness", () => {
    const p = fixture();
    const wall = p.walls[0];
    expect(wall).toBeDefined();
    const d = describeEntity(p, (wall as { id: string }).id);
    expect(d?.kind).toBe("wall");
    expect(d?.title).toBe("Wall");
    expect(d?.facts.map((f) => f.label)).toEqual([
      "Kind",
      "Start X",
      "Start Y",
      "End X",
      "End Y",
      "Length",
      "Thickness",
    ]);
    // a real length, grouped as a drawing writes it, not a placeholder
    expect(d?.facts.find((f) => f.label === "Length")?.value).toBe(`8${NARROW}000`);
  });

  it("groups a wall's rows as position and size, with its kind ahead of both (ADR-017 D3)", () => {
    const p = fixture();
    const d = describeEntity(p, (p.walls[0] as { id: string }).id);
    expect(d?.facts.map((f) => f.group ?? null)).toEqual([
      null,
      "Position",
      "Position",
      "Position",
      "Position",
      "Size",
      "Size",
    ]);
  });

  it("prints a point's name once and its axes inside the fields, and says all of it", () => {
    const p = fixture();
    const d = describeEntity(p, (p.walls[0] as { id: string }).id);
    const printed = d?.facts.map((f) => [f.caption ?? f.label, f.prefix ?? null]);
    expect(printed?.slice(1, 5)).toEqual([
      ["Start", "X"],
      ["", "Y"],
      ["End", "X"],
      ["", "Y"],
    ]);
    // what is printed is always the start of what is heard, or a speech user could not say it
    for (const f of d?.facts ?? []) expect(f.label.startsWith(f.caption ?? f.label), f.label).toBe(true);
  });

  it("describes a room by its corners, area and purpose", () => {
    const p = withRoom();
    const room = p.rooms[0];
    expect(room).toBeDefined();
    const d = describeEntity(p, (room as { id: string }).id);
    expect(d?.kind).toBe("room");
    expect(d?.facts.map((f) => f.label)).toEqual(["Corners", "Area", "Purpose"]);
    // square metres, and a detected room of a six-wall plan is not zero
    const area = Number(d?.facts[1]?.value.replace(" m²", ""));
    expect(area).toBeGreaterThan(0);
  });

  it("offers every row of a straight wall for editing", () => {
    const p = fixture();
    const d = describeEntity(p, (p.walls[0] as { id: string }).id);
    expect(d?.facts.every((f) => f.edit)).toBe(true);
  });

  it("returns null for an id that is not in the project", () => {
    expect(describeEntity(fixture(), "wall_zzzzzz")).toBeNull();
  });

  it("returns null for a kind the editor does not handle", () => {
    expect(describeEntity(fixture(), "zone_000001")).toBeNull();
  });
});

describe("typing a wall's thickness", () => {
  const thicknessOf = (p: ProjectT, wallId: string): Fact => {
    const fact = describeEntity(p, wallId)?.facts.find((f) => f.label === "Thickness");
    if (!fact?.edit) throw new Error("thickness is not editable");
    return fact;
  };
  const commandOf = (outcome: EditOutcome) => {
    if (!outcome.ok || !outcome.command)
      throw new Error(`expected a command, got ${JSON.stringify(outcome)}`);
    return outcome.command;
  };

  it("shows the bare number, with the unit beside it", () => {
    const p = fixture();
    const wall = p.walls[0] as ProjectT["walls"][number];
    const fact = thicknessOf(p, wall.id);
    expect(fact.value).toBe(String(wall.thickness));
    expect(fact.unit).toBe("mm");
  });

  it("builds a wall.modify the real reducer takes, and only the thickness changes", () => {
    const p = fixture();
    const wall = p.walls[0] as ProjectT["walls"][number];
    const outcome = thicknessOf(p, wall.id).edit?.("1.5 cm") as EditOutcome;
    expect(outcome).toMatchObject({ ok: true, said: "15 millimetres" });
    const command = commandOf(outcome);
    expect(command).toEqual({
      type: "wall.modify",
      payload: { wallId: wall.id, changes: { thickness: 15 } },
    });

    const r = apply(p, command, ctx);
    if (!r.ok) throw new Error(r.error.message);
    const after = r.project.walls.find((w) => w.id === wall.id);
    expect(after?.thickness).toBe(15);
    expect(after?.start).toEqual(wall.start);
    expect(after?.end).toEqual(wall.end);
    expect(r.changes.updated).toContainEqual({ type: "wall", id: wall.id });
  });

  it("sends nothing when the text names the thickness already there", () => {
    const p = fixture();
    const wall = p.walls[0] as ProjectT["walls"][number];
    const edit = thicknessOf(p, wall.id).edit as (text: string) => EditOutcome;
    expect(edit(String(wall.thickness))).toMatchObject({ ok: true, command: null });
    // rounding lands on the same whole millimetre, so that is no change either
    expect(edit(`${wall.thickness}.2`)).toMatchObject({ ok: true, command: null });
  });

  it("refuses text that is not a length, in words that say what to type", () => {
    const p = fixture();
    const edit = thicknessOf(p, (p.walls[0] as { id: string }).id).edit as (text: string) => EditOutcome;
    expect(edit("thick")).toEqual({
      ok: false,
      message: "Thickness needs a number of millimetres, such as 120.",
    });
  });

  it("refuses a thickness outside the range, naming the range (W-072)", () => {
    const p = fixture();
    const edit = thicknessOf(p, (p.walls[0] as { id: string }).id).edit as (text: string) => EditOutcome;
    const refusal = { ok: false, message: "Thickness must be from 1 to 10000 mm." };
    expect(edit("0")).toEqual(refusal);
    expect(edit("-100")).toEqual(refusal);
    expect(edit("10.001 m")).toEqual(refusal);
    expect(edit(String(THICKNESS_RANGE.max))).toMatchObject({ ok: true });
    expect(edit(String(THICKNESS_RANGE.min))).toMatchObject({ ok: true });
  });
});

describe("typing where a wall's ends are", () => {
  it("moves the start, and the wall joined there comes with it (W-031)", () => {
    const p = fixture();
    const command = typed(p, W1, "Start X", "-500");
    expect(command).toEqual({
      type: "wall.modify",
      payload: { wallId: W1, changes: { start: { x: -500, y: 0 } } },
    });
    const { project, updated } = run(p, command);
    expect(wallOf(project, W1).start).toEqual({ x: -500, y: 0 });
    expect(wallOf(project, W1).end).toEqual({ x: 8000, y: 0 });
    expect(wallOf(project, "wall_000006").end).toEqual({ x: -500, y: 0 });
    expect(updated).toContainEqual({ type: "wall", id: "wall_000006" });
  });

  it("changes one axis of the end and keeps the other", () => {
    const p = fixture();
    const { project } = run(p, typed(p, W1, "End Y", "1.5 m"));
    expect(wallOf(project, W1).end).toEqual({ x: 8000, y: 1500 });
    expect(wallOf(project, "wall_000002").start).toEqual({ x: 8000, y: 1500 });
  });

  it("reads back the grouped figure it shows, as no change", () => {
    const p = fixture();
    const row = rowOf(p, W1, "End X");
    expect(row.value).toBe(`8${NARROW}000`);
    expect(row.edit?.(row.value)).toMatchObject({ ok: true, command: null });
  });

  it("refuses an end typed onto the other end, before the host has to", () => {
    const p = fixture();
    expect(rowOf(p, W1, "End X").edit?.("0")).toEqual({
      ok: false,
      message: "That would put both ends of the wall on one point.",
    });
  });

  it("refuses a coordinate further out than the wall tool allows (W-072)", () => {
    const p = fixture();
    expect(rowOf(p, W1, "Start X").edit?.("1001 m")).toEqual({
      ok: false,
      message: "Start X must be from -1000000 to 1000000 mm.",
    });
  });
});

describe("typing a wall's length", () => {
  it("moves the end along the wall, keeping the start, and the joined wall follows", () => {
    const p = fixture();
    const command = typed(p, W1, "Length", "6 m");
    expect(command).toEqual({
      type: "wall.modify",
      payload: { wallId: W1, changes: { end: { x: 6000, y: 0 } } },
    });
    const { project } = run(p, command);
    expect(wallOf(project, W1).start).toEqual({ x: 0, y: 0 });
    expect(wallOf(project, "wall_000002").start).toEqual({ x: 6000, y: 0 });
  });

  it("keeps the direction of a sloping wall, to within the rounding to whole millimetres", () => {
    // 60 degrees, where neither end coordinate of the new length is a whole number
    const p = run(fixture(), {
      type: "wall.modify",
      payload: { wallId: W1, changes: { end: { x: 1000, y: 1732 } } },
    }).project;
    const before = derive.wallAngle(wallOf(p, W1));
    const { project } = run(p, typed(p, W1, "Length", "1000"));
    const after = wallOf(project, W1);
    expect(after.end).toEqual({ x: 500, y: 866 });
    expect(formatMm(derive.wallLength(after))).toBe(`1${NARROW}000`);
    expect(Math.abs(derive.wallAngle(after) - before)).toBeLessThan(0.1);
  });

  it("refuses no length at all", () => {
    const p = fixture();
    expect(rowOf(p, W1, "Length").edit?.("0")).toEqual({
      ok: false,
      message: "Length must be from 1 to 1000000 mm.",
    });
  });

  it("shows a curved wall's length along the curve, and does not take a typed one", () => {
    const p = run(fixture(), {
      type: "wall.modify",
      payload: { wallId: W1, changes: { arcExtent: 90 } },
    }).project;
    const wall = wallOf(p, W1);
    const row = rowOf(p, W1, "Length");
    expect(row.edit).toBeUndefined();
    expect(row.value).toBe(formatMm(derive.wallArcLength(wall)));
    // along the curve, so longer than the 8 m between the ends
    expect(derive.wallArcLength(wall)).toBeGreaterThan(8000);
  });
});

describe("picking a wall's kind", () => {
  it("offers the kinds the model has, in the wall tool's words", () => {
    const p = fixture();
    const row = rowOf(p, W1, "Kind");
    expect(row.choices).toBe(WALL_KINDS);
    expect(WALL_KINDS.map((k) => k.value).sort()).toEqual([...WallKind.options].sort());
    expect(row.value).toBe("interior");
  });

  it("sends the pick, and says it by its label", () => {
    const p = fixture();
    const outcome = rowOf(p, W1, "Kind").edit?.("glass");
    expect(outcome).toEqual({
      ok: true,
      command: { type: "wall.modify", payload: { wallId: W1, changes: { kind: "glass" } } },
      said: "Glass",
    });
    const { project } = run(p, (outcome as { command: EditCommand }).command);
    expect(wallOf(project, W1).kind).toBe("glass");
  });

  it("sends nothing for the kind already there, and refuses one that is not a kind", () => {
    const p = fixture();
    const edit = rowOf(p, W1, "Kind").edit as (value: string) => EditOutcome;
    expect(edit("interior")).toMatchObject({ ok: true, command: null });
    expect(edit("brick")).toEqual({
      ok: false,
      message: "Kind must be one of Exterior, Interior, Partition, Glass.",
    });
  });
});
