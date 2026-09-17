// @vitest-environment jsdom
//
// How the properties panel lays a selection out (P3-5 follow-up): two to a line and never more, the whole
// line for what needs it, and a surface's material and colour as one field.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Project, type Project as ProjectT } from "@fpv/ir";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { Announcer } from "../../src/editor/announce.js";
import { layout, PropertiesPanel } from "../../src/editor/PropertiesPanel.js";
import { describeEntity, type Fact } from "../../src/editor/selection.js";
import { type Editor, EditorContext } from "../../src/editor/useEditor.js";
import { Replica } from "../../src/replica.js";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

// jsdom brings its own URL, which node's fileURLToPath refuses, so the path is built from the string.
const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/fixtures/boardroom.fpviz",
);
const boardroom = (): ProjectT => Project.parse(JSON.parse(readFileSync(`${fixture}/project.json`, "utf8")));

/**
 * A band laid out as lines, "|" between them: a name for each cell, "*" after one taking the whole line.
 * The lines are worked out the way the grid places cells: two halves, or one whole, to a line.
 */
function lines(facts: readonly Fact[], group: string | null): string {
  const out: string[][] = [];
  let used = 2;
  for (const c of layout(facts.filter((f) => (f.group ?? null) === group))) {
    const name = c.kind === "fill" ? `fill(${c.colour.caption})` : c.fact.caption || c.fact.label;
    if (c.first || used + c.span > 2) {
      out.push([]);
      used = 0;
    }
    out.at(-1)?.push(c.span === 2 ? `${name}*` : name);
    used += c.span;
  }
  return out.map((l) => l.join(" ")).join(" | ");
}

describe("laying out the panel", () => {
  it("never puts more than two values on a line", () => {
    const p = boardroom();
    const ids = [...p.walls, ...p.rooms, ...p.openings, ...p.items].map((e) => e.id);
    for (const id of ids) {
      const d = describeEntity(p, id);
      if (!d) continue;
      for (const cell of layout(d.facts)) expect([1, 2]).toContain(cell.span);
    }
  });

  it("pairs a wall's numbers, and gives each side's colour and material a line of their own", () => {
    const p = boardroom();
    const wall = describeEntity(p, p.walls[0]?.id as string);
    if (!wall) throw new Error("no wall");
    expect(lines(wall.facts, null)).toBe("Kind Plan pattern");
    expect(lines(wall.facts, "Position")).toBe("Start Start Y | End End Y");
    expect(lines(wall.facts, "Shape and size")).toBe("Length Thickness | Height Height at end | Curve");
    const side = wall.facts.find((f) => f.group?.startsWith("Left side"))?.group ?? null;
    expect(lines(wall.facts, side)).toBe("fill(Colour)* | Finish Baseboard height");
  });

  it("pairs an item's position, turn and size, with the mirror last", () => {
    const p = boardroom();
    const chair = p.items.find((i) => i.ref.kind === "product" && i.ref.productId.includes("aeron"));
    const d = describeEntity(p, chair?.id as string);
    if (!d) throw new Error("no chair");
    expect(lines(d.facts, "Placement")).toBe(
      "Position Position Y | Rotation Elevation | Width Depth | Height Mirrored",
    );
    expect(lines(d.facts, "Product")).toBe("Make Category | Model Checked");
    const table = p.items.find((i) => i.ref.kind === "product" && i.ref.productId.includes("convene-3600"));
    const t = describeEntity(p, table?.id as string);
    // a long model name takes the line
    expect(lines(t?.facts ?? [], "Product")).toBe("Make Category | Model* | Checked");
  });

  it("gives a room's name the line, and its floor a colour and a checkbox", () => {
    const p = boardroom();
    const room = describeEntity(p, p.rooms[0]?.id as string);
    if (!room) throw new Error("no room");
    expect(lines(room.facts, null)).toBe("Name* | Purpose Capacity");
    expect(lines(room.facts, "Floor")).toBe("fill(Colour)* | Show");
  });
});

describe("the panel", () => {
  function show(ids: string[]) {
    const replica = new Replica();
    replica.applySnapshot({
      type: "snapshot",
      seq: 1,
      project: boardroom(),
      historyPosition: 0,
      savedPosition: 0,
    });
    replica.setSelection(ids);
    const editor = {
      announcer: new Announcer({ polite: { textContent: "" }, assertive: { textContent: "" } }),
    } as Partial<Editor> as Editor;
    render(
      <EditorContext.Provider value={editor}>
        <TooltipProvider>
          <PropertiesPanel replica={replica} level={null} send={async () => {}} />
        </TooltipProvider>
      </EditorContext.Provider>,
    );
  }

  it("titles the selection, says what it is when its name does not, and names each band", () => {
    const p = boardroom();
    show([p.rooms[0]?.id as string]);
    const title = screen.getByRole("heading", { name: p.rooms[0]?.name ?? "" });
    expect(title.nextElementSibling?.textContent).toBe("Room");
    expect(screen.getByRole("group", { name: "Floor" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Level" })).toBeNull();
  });

  it("prints millimetres in the fields, and a wall is not called Wall twice", () => {
    const p = boardroom();
    show([p.walls[0]?.id as string]);
    const title = screen.getByRole("heading", { name: "Wall" });
    expect(title.nextElementSibling).toBeNull();
    const thickness = screen.getByRole("textbox", { name: "Thickness, in millimetres" });
    expect(thickness.parentElement?.textContent).toContain("mm");
  });

  it("offers a surface's material from the end of its colour field, under the material's own name", () => {
    const p = boardroom();
    show([p.walls[0]?.id as string]);
    const material = screen.getByRole("combobox", { name: "Material, left side" });
    const colour = screen.getByRole("textbox", { name: "Colour, left side" });
    expect(colour.parentElement?.contains(material)).toBe(true);
    expect(material.textContent).toContain("Paint");
  });

  it("shows the level when nothing is selected", () => {
    show([]);
    expect(screen.getByRole("heading", { name: "Level" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Height of level, in millimetres" })).toBeDefined();
  });
});
