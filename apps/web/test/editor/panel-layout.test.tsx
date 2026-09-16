// @vitest-environment jsdom
//
// How the properties panel lays a selection out (P3-5 follow-up): short values share a line, a surface's
// material and colour are one field, and the whole of a chair fits where a column of rows did not.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Project, type Project as ProjectT } from "@fpv/ir";
import { cleanup, render, screen } from "@testing-library/react";
import { isValidElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { Announcer } from "../../src/editor/announce.js";
import { glyphOf, layout, PropertiesPanel } from "../../src/editor/PropertiesPanel.js";
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

/** Each band's cells as "name:span", a line at a time, with "|" between lines. */
function lines(facts: readonly Fact[], group: string | null): string {
  const cells = layout(facts.filter((f) => (f.group ?? null) === group));
  return cells
    .map((c) => {
      const name = c.kind === "fill" ? `fill(${c.colour.caption})` : (c.fact.caption ?? c.fact.label);
      return `${c.first ? "| " : ""}${name}:${c.span}`;
    })
    .join(" ")
    .replace(/^\| /, "");
}

describe("laying out the panel", () => {
  it("puts a wall's numbers two and three to a line, and each side's colour and material in one field", () => {
    const p = boardroom();
    const wall = describeEntity(p, p.walls[0]?.id as string);
    if (!wall) throw new Error("no wall");
    expect(lines(wall.facts, null)).toBe("Kind:3 Plan pattern:3");
    expect(lines(wall.facts, "Position")).toBe("Start:3 :3 | End:3 :3");
    // "straight" is short enough for a third; the level's height is not
    expect(lines(wall.facts, "Shape and size")).toBe(
      "Curve:2 Length:2 Thickness:2 | Height:3 Height at end:3",
    );
    const side = wall.facts.find((f) => f.group?.startsWith("Left side"))?.group ?? null;
    expect(lines(wall.facts, side)).toBe("fill(Colour):4 Finish:2 | Height of baseboard:3");
  });

  it("puts an item's turn, height and mirror on one line, and its size on the next", () => {
    const p = boardroom();
    const chair = p.items.find((i) => i.ref.kind === "product" && i.ref.productId.includes("aeron"));
    const d = describeEntity(p, chair?.id as string);
    if (!d) throw new Error("no chair");
    expect(lines(d.facts, "Placement")).toBe(
      "Position:3 :3 | Rotation:2 Elevation:2 Mirrored:2 | Width:2 Depth:2 Height:2",
    );
    expect(lines(d.facts, "Product")).toBe("Make:3 Model:3 | Category:3 Checked:3");
    const table = p.items.find((i) => i.ref.kind === "product" && i.ref.productId.includes("convene-3600"));
    const t = describeEntity(p, table?.id as string);
    // a long model name takes the line
    expect(lines(t?.facts ?? [], "Product")).toBe("Make:3 | Model:6 | Category:3 Checked:3");
  });

  it("widens a line left short, and gives a room's floor its colour and a checkbox", () => {
    const p = boardroom();
    const room = describeEntity(p, p.rooms[0]?.id as string);
    if (!room) throw new Error("no room");
    expect(lines(room.facts, null)).toBe("Name:6 | Purpose:3 Capacity:3");
    expect(lines(room.facts, "Floor")).toBe("fill(Colour):4 Show:2");
    expect(lines(room.facts, "Ceiling")).toBe("Height:3 | fill(Colour):4 Show:2");
  });

  it("marks a number by its axis, an icon, or its first letter, and nothing else", () => {
    const glyph = (fact: Partial<Fact>) => glyphOf({ label: "x", value: "", ...fact });
    expect(glyph({ label: "Start X", caption: "Start", prefix: "X", unit: "mm" })).toBe("X");
    expect(glyph({ label: "Thickness", unit: "mm" })).toBe("T");
    expect(
      glyph({ label: "Height of baseboard, left side", caption: "Height of baseboard", unit: "mm" }),
    ).toBe("H");
    expect(isValidElement(glyph({ label: "Rotation", unit: "°" }))).toBe(true);
    expect(isValidElement(glyph({ label: "Capacity", unit: "seats" }))).toBe(true);
    expect(glyph({ label: "Kind" })).toBeUndefined();
  });
});

describe("the panel", () => {
  function show(id: string) {
    const replica = new Replica();
    const project = boardroom();
    replica.applySnapshot({ type: "snapshot", seq: 1, project, historyPosition: 0, savedPosition: 0 });
    replica.setSelection([id]);
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
    return project;
  }

  it("titles the selection, names each band, and leaves the level out while something is selected", () => {
    const p = boardroom();
    show(p.walls[0]?.id as string);
    expect(screen.getByRole("heading", { name: "Wall" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Shape and size" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Level" })).toBeNull();
    // lengths are said once per band, and still in every field's name
    expect(screen.getByRole("textbox", { name: "Thickness, in millimetres" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Shape and size" }).textContent).toContain("mm");
  });

  it("offers a surface's material from the end of its colour field, under the material's own name", () => {
    const p = boardroom();
    show(p.walls[0]?.id as string);
    const material = screen.getByRole("combobox", { name: "Material, left side" });
    const colour = screen.getByRole("textbox", { name: "Colour, left side" });
    // one field: the list sits inside the colour's box
    expect(colour.parentElement?.contains(material)).toBe(true);
    expect(material.textContent).toContain("Paint");
  });

  it("shows the level when nothing is selected", () => {
    const replica = new Replica();
    replica.applySnapshot({
      type: "snapshot",
      seq: 1,
      project: boardroom(),
      historyPosition: 0,
      savedPosition: 0,
    });
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
    expect(screen.getByRole("heading", { name: "Level" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Height of level, in millimetres" })).toBeDefined();
  });
});
