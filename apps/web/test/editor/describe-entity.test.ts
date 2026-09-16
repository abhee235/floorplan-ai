// describeEntity against a real project, not a hand-built stub.
//
// This is the function that carries every schema assumption in selection.ts — which field names exist,
// which are nullable, what a thing is called. A stub would only assert the shape I already believed, and
// that belief was wrong once already: Item has no `name` field, and the first version of itemTitle read
// one. The six-wall fixture is the same project the render tests use.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, type Ctx } from "@fpv/commands";
import { buildWalls } from "@fpv/engine";
import { derive, Project, type Project as ProjectT, sequentialIdGenerator, WallKind } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import {
  CURVE_LIMIT,
  describeEntity,
  type EditCommand,
  type EditOutcome,
  type Fact,
  HEIGHT_RANGE,
  SKIRTING_DEPTH,
  SKIRTING_DEPTH_RANGE,
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
  it("describes a wall by its kind, its ends, its curve, its size and its heights", () => {
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
      "Curve",
      "Length",
      "Thickness",
      "Height",
      "Height at end",
      "Colour, left side",
      "Finish, left side",
      "Baseboard height, left side",
      "Colour, right side",
      "Finish, right side",
      "Baseboard height, right side",
    ]);
    // a real length, grouped as a drawing writes it, not a placeholder
    expect(d?.facts.find((f) => f.label === "Length")?.value).toBe(`8${NARROW}000`);
  });

  it("groups a wall's rows as position, shape, size and height, with its kind ahead (ADR-017 D3)", () => {
    const p = fixture();
    const d = describeEntity(p, (p.walls[0] as { id: string }).id);
    expect(d?.facts.map((f) => f.group ?? null)).toEqual([
      null,
      "Position",
      "Position",
      "Position",
      "Position",
      "Shape",
      "Size",
      "Size",
      "Height",
      "Height",
      "Left side, facing north",
      "Left side, facing north",
      "Left side, facing north",
      "Right side, facing south",
      "Right side, facing south",
      "Right side, facing south",
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

/** What editing a row asks for, whatever it is: a command, nothing, or a refusal. */
const outcomeOf = (p: ProjectT, id: string, label: string, text: string): EditOutcome =>
  (rowOf(p, id, label).edit as (text: string) => EditOutcome)(text);

const modified = (p: ProjectT, changes: Record<string, unknown>): ProjectT =>
  run(p, { type: "wall.modify", payload: { wallId: W1, changes } }).project;

describe("typing how far a wall curves", () => {
  it("shows a straight wall as empty, standing for straight", () => {
    const row = rowOf(fixture(), W1, "Curve");
    expect(row.value).toBe("");
    expect(row.unit).toBe("°");
    expect(row.empty).toEqual({ shown: "straight", action: "Make the wall straight" });
    // which way the sign bows is not something anyone can guess, so a screen reader is told
    expect(row.hint).toContain("bows to the left");
  });

  it("curves a straight wall, and the curve bows to the left for a positive extent", () => {
    const p = fixture();
    const outcome = outcomeOf(p, W1, "Curve", "90°");
    expect(outcome).toEqual({
      ok: true,
      command: { type: "wall.modify", payload: { wallId: W1, changes: { arcExtent: 90 } } },
      said: "90 degrees",
    });
    const wall = wallOf(run(p, (outcome as { command: EditCommand }).command).project, W1);
    // wall 1 runs along +x, so its left is +y, and the concave side's centre is on the right
    expect(derive.arcParams(wall)?.centre.y).toBeLessThan(0);
  });

  it("takes a negative and a fractional curve, to a tenth", () => {
    const p = fixture();
    expect(typed(p, W1, "Curve", "-45.25").payload).toEqual({ wallId: W1, changes: { arcExtent: -45.3 } });
    expect(rowOf(modified(p, { arcExtent: -45.3 }), W1, "Curve").value).toBe("-45.3");
  });

  it("straightens a curved wall when the field is emptied or given 0", () => {
    const p = modified(fixture(), { arcExtent: 90 });
    const straighten = { type: "wall.modify", payload: { wallId: W1, changes: { arcExtent: null } } };
    expect(outcomeOf(p, W1, "Curve", "")).toEqual({ ok: true, command: straighten, said: "straight" });
    expect(outcomeOf(p, W1, "Curve", "0")).toEqual({ ok: true, command: straighten, said: "straight" });
    // and a wall already straight asks for nothing
    expect(outcomeOf(fixture(), W1, "Curve", "")).toMatchObject({ ok: true, command: null });
  });

  it("sends nothing for the curve already there, however it was typed", () => {
    const p = modified(fixture(), { arcExtent: 90 });
    expect(outcomeOf(p, W1, "Curve", "90.0 deg")).toMatchObject({ ok: true, command: null });
  });

  it("refuses a curve past the schema's limit, and text that is not an angle", () => {
    const p = fixture();
    expect(outcomeOf(p, W1, "Curve", String(CURVE_LIMIT + 1))).toEqual({
      ok: false,
      message: "Curve must be from -270 to 270 degrees.",
    });
    expect(outcomeOf(p, W1, "Curve", `-${CURVE_LIMIT}`)).toMatchObject({ ok: true });
    expect(outcomeOf(p, W1, "Curve", "quarter")).toEqual({
      ok: false,
      message: "Curve needs a number of degrees, such as 90.",
    });
  });
});

describe("typing a wall's height (W-092, W-094)", () => {
  it("shows a wall that follows the level as empty, standing for the level's height", () => {
    const row = rowOf(fixture(), W1, "Height");
    expect(row.value).toBe("");
    expect(row.empty).toEqual({ shown: `level · 2${NARROW}700 mm`, action: "Follow the level's height" });
    expect(row.hint).toBe("Empty follows the level, 2700 millimetres.");
  });

  it("gives the wall a height of its own", () => {
    const p = fixture();
    const { project } = run(p, typed(p, W1, "Height", "3 m"));
    expect(wallOf(project, W1).height).toBe(3000);
    expect(rowOf(project, W1, "Height").value).toBe(`3${NARROW}000`);
  });

  it("takes the level's own height as a height of the wall's own, which it then keeps", () => {
    // typed into the empty field, 2700 is a decision to stop following the level, so it is sent
    const p = fixture();
    expect(typed(p, W1, "Height", "2700").payload).toEqual({ wallId: W1, changes: { height: 2700 } });
  });

  it("follows the level again when emptied", () => {
    const p = modified(fixture(), { height: 3000 });
    expect(outcomeOf(p, W1, "Height", " ")).toEqual({
      ok: true,
      command: { type: "wall.modify", payload: { wallId: W1, changes: { height: null } } },
      said: "follows the level, 2700 millimetres",
    });
    expect(outcomeOf(fixture(), W1, "Height", "")).toMatchObject({ ok: true, command: null });
  });

  it("refuses a height past a hundred metres, or none at all", () => {
    const p = fixture();
    const refusal = { ok: false, message: `Height must be from 1 to ${HEIGHT_RANGE.max} mm.` };
    expect(outcomeOf(p, W1, "Height", "0")).toEqual(refusal);
    expect(outcomeOf(p, W1, "Height", "100.001 m")).toEqual(refusal);
  });

  it("does not offer to empty a sloping wall's start, and refuses it in words", () => {
    // emptying it would let the model move the end height into the start and flatten the wall
    const p = modified(fixture(), { height: 3000, heightAtEnd: 2000 });
    const row = rowOf(p, W1, "Height");
    expect(row.empty).toBeUndefined();
    expect(row.hint).toBe("The height at the start of this sloping wall.");
    expect(outcomeOf(p, W1, "Height", "")).toEqual({
      ok: false,
      message: "A sloping wall needs its own height at the start. Empty the height at end first.",
    });
  });
});

describe("typing the height at a wall's end", () => {
  it("shows a flat top as an empty end, standing for the start's height", () => {
    const row = rowOf(fixture(), W1, "Height at end");
    expect(row.value).toBe("");
    expect(row.empty).toEqual({ shown: `same · 2${NARROW}700 mm`, action: "Make the top flat" });
    expect(row.hint).toBe("Empty keeps the top flat, at the start's 2700 millimetres.");
  });

  it("slopes a wall that has a height of its own", () => {
    const p = modified(fixture(), { height: 3000 });
    const { project } = run(p, typed(p, W1, "Height at end", "2000"));
    const wall = wallOf(project, W1);
    expect([wall.height, wall.heightAtEnd]).toEqual([3000, 2000]);
    expect(derive.isTrapezoidal(wall)).toBe(true);
  });

  it("slopes a wall that follows the level by fixing its start where it shows, not by moving the end there", () => {
    const p = fixture();
    const command = typed(p, W1, "Height at end", "2000");
    expect(command.payload).toEqual({ wallId: W1, changes: { height: 2700, heightAtEnd: 2000 } });
    const wall = wallOf(run(p, command).project, W1);
    expect([wall.height, wall.heightAtEnd]).toEqual([2700, 2000]);
  });

  it("flattens the top when the end is emptied, or given the start's height", () => {
    const p = modified(fixture(), { height: 3000, heightAtEnd: 2000 });
    const flatten = { type: "wall.modify", payload: { wallId: W1, changes: { heightAtEnd: null } } };
    expect(outcomeOf(p, W1, "Height at end", "")).toEqual({
      ok: true,
      command: flatten,
      said: "flat, 3000 millimetres",
    });
    expect(outcomeOf(p, W1, "Height at end", "3000")).toMatchObject({ ok: true, command: flatten });
    const wall = wallOf(run(p, flatten).project, W1);
    expect([wall.height, wall.heightAtEnd]).toEqual([3000, null]);
  });

  it("sends nothing for the start's height on a top that is already flat", () => {
    expect(outcomeOf(fixture(), W1, "Height at end", "2700")).toMatchObject({ ok: true, command: null });
    expect(outcomeOf(fixture(), W1, "Height at end", "")).toMatchObject({ ok: true, command: null });
  });
});

describe("painting a wall's sides (W-106)", () => {
  const W2 = "wall_000002"; // runs north, so its left faces west
  const blank = { color: null, textureId: null, placement: null, mirrorForLeftSide: false, shininess: null };
  const finishesOf = (p: ProjectT, id: string) => wallOf(p, id).finishes;

  it("names each side by the way it faces, since left and right are invisible on a plan", () => {
    const groups = describeEntity(fixture(), W2)?.facts.map((f) => f.group);
    expect(groups).toContain("Left side, facing west");
    expect(groups).toContain("Right side, facing east");
  });

  it("shows an unpainted side as empty, standing for the default colour, and matt", () => {
    const colour = rowOf(fixture(), W1, "Colour, left side");
    expect(colour.value).toBe("");
    expect(colour.caption).toBe("Colour");
    expect(colour.colour).toEqual({ effective: "#E8E6E1" });
    expect(colour.empty).toEqual({ shown: "default", action: "Use the default colour" });
    expect(rowOf(fixture(), W1, "Finish, left side")).toMatchObject({
      value: "matt",
      choices: expect.any(Array),
    });
  });

  it("paints one side, leaves the other alone, and the wall builds with that colour", () => {
    const p = fixture();
    const command = typed(p, W1, "Colour, left side", "f00");
    expect(command.payload).toEqual({
      wallId: W1,
      changes: { finishes: { left: { ...blank, color: "#FF0000" }, right: null, top: null } },
    });
    const { project } = run(p, command);
    expect(finishesOf(project, W1).left?.color).toBe("#FF0000");
    expect(finishesOf(project, W1).right).toBeNull();
    const level = project.levels[0] as ProjectT["levels"][number];
    const parts = buildWalls(project.walls, project.openings, { level, isLowest: true, isHighest: true });
    const side = (kind: string) => parts.find((x) => x.entityId === W1 && x.part === kind)?.materialKey;
    expect(side("wall-left")).toBe("wall-side|#FF0000|");
    expect(side("wall-right")).toBe("wall-side");
  });

  it("keeps what the other side already wears when this one changes", () => {
    const p = run(fixture(), typed(fixture(), W1, "Colour, left side", "#00FF00")).project;
    const { project } = run(p, typed(p, W1, "Colour, right side", "#0000FF"));
    expect(finishesOf(project, W1).left?.color).toBe("#00FF00");
    expect(finishesOf(project, W1).right?.color).toBe("#0000FF");
  });

  it("sends nothing for the colour already there, and refuses what is not a colour", () => {
    const p = run(fixture(), typed(fixture(), W1, "Colour, left side", "#ABCDEF")).project;
    expect(outcomeOf(p, W1, "Colour, left side", "abcdef")).toMatchObject({ ok: true, command: null });
    expect(outcomeOf(p, W1, "Colour, left side", "teal")).toEqual({
      ok: false,
      message: "Colour needs a hex value, such as #E8E6E1.",
    });
  });

  it("gives a side back to the default when its colour is emptied, storing no finish at all", () => {
    const p = run(fixture(), typed(fixture(), W1, "Colour, left side", "#ABCDEF")).project;
    const { project } = run(p, typed(p, W1, "Colour, left side", ""));
    expect(finishesOf(project, W1).left).toBeNull();
    // but a side that is still glossy keeps its finish, with only the colour gone
    const glossy = run(p, typed(p, W1, "Finish, left side", "gloss")).project;
    const cleared = run(glossy, typed(glossy, W1, "Colour, left side", "")).project;
    expect(finishesOf(cleared, W1).left).toEqual({ ...blank, shininess: 0.6 });
  });

  it("sets the finish as a shininess, and matt as none", () => {
    const p = fixture();
    const satin = run(p, typed(p, W1, "Finish, left side", "satin")).project;
    expect(finishesOf(satin, W1).left).toEqual({ ...blank, shininess: 0.25 });
    expect(rowOf(satin, W1, "Finish, left side").value).toBe("satin");
    const matt = run(satin, typed(satin, W1, "Finish, left side", "matt")).project;
    expect(finishesOf(matt, W1).left).toBeNull();
    expect(outcomeOf(p, W1, "Finish, left side", "matt")).toMatchObject({ ok: true, command: null });
  });

  it("shows a shininess set by someone else as the nearest of the three finishes", () => {
    const at = (shininess: number) =>
      rowOf(
        modified(fixture(), { finishes: { left: { ...blank, shininess }, right: null, top: null } }),
        W1,
        "Finish, left side",
      ).value;
    expect([at(0.05), at(0.2), at(0.5), at(1)]).toEqual(["matt", "satin", "gloss", "gloss"]);
  });
});

describe("giving a wall's sides a baseboard (ADR-014 D8)", () => {
  const skirtingOf = (p: ProjectT, id: string) => wallOf(p, id).skirting;
  const labelsOf = (p: ProjectT) => (describeEntity(p, W1)?.facts ?? []).map((f) => f.label);

  it("shows no baseboard as an empty height standing for none, with no depth to set", () => {
    const row = rowOf(fixture(), W1, "Baseboard height, left side");
    expect(row).toMatchObject({ value: "", caption: "Baseboard", unit: "mm" });
    expect(row.empty).toEqual({ shown: "none", action: "Remove the baseboard" });
    expect(labelsOf(fixture())).not.toContain("Depth of baseboard, left side");
  });

  it("adds a baseboard of the usual depth when a height is typed, and the wall builds it", () => {
    const p = fixture();
    const command = typed(p, W1, "Baseboard height, left side", "100");
    expect(command.payload).toEqual({
      wallId: W1,
      changes: { skirting: { left: { thickness: SKIRTING_DEPTH, height: 100 }, right: null } },
    });
    const { project } = run(p, command);
    expect(skirtingOf(project, W1)).toEqual({ left: { thickness: 12, height: 100 }, right: null });
    const level = project.levels[0] as ProjectT["levels"][number];
    const parts = buildWalls(project.walls, project.openings, { level, isLowest: true, isHighest: true });
    expect(parts.some((x) => x.entityId === W1 && x.part === "skirting-left")).toBe(true);
    // and now there is a depth to set
    expect(labelsOf(project)).toContain("Depth of baseboard, left side");
    expect(rowOf(project, W1, "Depth of baseboard, left side")).toMatchObject({
      value: "12",
      caption: "Depth",
    });
  });

  it("changes the depth and keeps the height, and the other side is left alone", () => {
    const p = run(fixture(), typed(fixture(), W1, "Baseboard height, right side", "80")).project;
    const q = run(p, typed(p, W1, "Baseboard height, left side", "100")).project;
    const { project } = run(q, typed(q, W1, "Depth of baseboard, left side", "18"));
    expect(skirtingOf(project, W1)).toEqual({
      left: { thickness: 18, height: 100 },
      right: { thickness: 12, height: 80 },
    });
  });

  it("removes the baseboard when its height is emptied", () => {
    const p = run(fixture(), typed(fixture(), W1, "Baseboard height, left side", "100")).project;
    const { project } = run(p, typed(p, W1, "Baseboard height, left side", ""));
    expect(skirtingOf(project, W1).left).toBeNull();
    expect(labelsOf(project)).not.toContain("Depth of baseboard, left side");
    expect(outcomeOf(fixture(), W1, "Baseboard height, left side", "")).toMatchObject({
      ok: true,
      command: null,
    });
  });

  it("W-100 refuses a baseboard taller than the wall, naming the wall's height", () => {
    expect(outcomeOf(fixture(), W1, "Baseboard height, left side", "2701")).toEqual({
      ok: false,
      message: "Baseboard height must be from 1 to 2700 mm.",
    });
    // a sloping wall is as tall as its taller end
    const sloped = modified(fixture(), { height: 3000, heightAtEnd: 2000 });
    expect(outcomeOf(sloped, W1, "Baseboard height, left side", "3000")).toMatchObject({ ok: true });
  });

  it("refuses a depth that is not a skirting board's", () => {
    const p = run(fixture(), typed(fixture(), W1, "Baseboard height, left side", "100")).project;
    expect(outcomeOf(p, W1, "Depth of baseboard, left side", "0")).toEqual({
      ok: false,
      message: `Baseboard depth must be from 1 to ${SKIRTING_DEPTH_RANGE.max} mm.`,
    });
  });
});
