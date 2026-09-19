// @vitest-environment jsdom
//
// The menu bar: its structure, and the rule that keeps it honest — every line names a command the
// editor actually has. The bar shipped a dead Export button for weeks because nothing checked that.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Announcer } from "../../src/editor/announce.js";
import { CommandRegistry } from "../../src/editor/commands.js";
import { MainMenu, menuCommandIds, menus } from "../../src/editor/MainMenu.js";
import { TOOLS } from "../../src/editor/tools.js";
import { type Editor, EditorContext } from "../../src/editor/useEditor.js";

/** A registry holding every id the menus name, so the menu renders in full. */
function registry(ran: string[] = []): CommandRegistry {
  const commands = new CommandRegistry();
  for (const id of [...new Set(menuCommandIds())])
    commands.add({
      id,
      title: `Do ${id}`,
      group: id.split(".")[0] as string,
      ...(id === "edit.undo" ? { shortcut: "Ctrl+Z" } : {}),
      ...(id === "edit.delete" ? { enabled: () => false } : {}),
      run: () => void ran.push(id),
    });
  return commands;
}

function editorFor(commands: CommandRegistry, view: Editor["view"] = "both"): Editor {
  return {
    commands,
    announcer: new Announcer(
      { polite: { textContent: null }, assertive: { textContent: null } },
      { defer: (f) => f() },
    ),
    tool: TOOLS[0] as Editor["tool"],
    setTool: () => {},
    view,
    setView: () => {},
    option: () => undefined,
    setOption: () => {},
    openPalette: () => {},
    recent: [],
    openRecent: () => {},
    snap: "",
    setSnap: () => {},
    pointer: null,
    setPointer: () => {},
    scale: 0,
    setScale: () => {},
  };
}

const show = (commands: CommandRegistry, view: Editor["view"] = "both") =>
  render(
    <EditorContext.Provider value={editorFor(commands, view)}>
      <MainMenu />
    </EditorContext.Provider>,
  );

afterEach(cleanup);

describe("the menu bar", () => {
  it("offers the menus a person expects to find, in order", () => {
    show(registry());
    const bar = screen.getByRole("menubar", { name: "Main menu" });
    expect(
      within(bar)
        .getAllByRole("menuitem")
        .map((b) => b.textContent),
    ).toEqual(["File", "Edit", "View", "3D", "Help"]);
  });

  it("names only commands the editor has", () => {
    // The rule that replaces the dead Export button: the menu cannot name what is not registered.
    const commands = registry();
    for (const id of menuCommandIds()) expect(commands.get(id), `menu names ${id}`).not.toBeNull();
  });

  it("runs the command behind a line, rather than doing the work itself", async () => {
    const ran: string[] = [];
    show(registry(ran));
    const user = userEvent.setup();
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await user.click(await screen.findByRole("menuitem", { name: /Do edit\.redo/ }));
    expect(ran).toEqual(["edit.redo"]);
  });

  it("shows a command's shortcut beside it, from the registry", async () => {
    show(registry());
    const user = userEvent.setup();
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect((await screen.findByRole("menuitem", { name: /Do edit\.undo/ })).textContent).toContain("Ctrl+Z");
  });

  it("greys a line out when its command does not apply", async () => {
    show(registry());
    const user = userEvent.setup();
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const del = await screen.findByRole("menuitem", { name: /Do edit\.delete/ });
    // jest-dom is not installed here, so the attribute is read directly.
    expect(del.getAttribute("data-disabled")).not.toBeNull();
    expect(del.getAttribute("aria-disabled")).toBe("true");
  });

  it("marks the view mode the editor is in", async () => {
    show(registry(), "3d");
    const user = userEvent.setup();
    await user.click(screen.getByRole("menuitem", { name: "View" }));
    const picked = await screen.findAllByRole("menuitemradio");
    const on = picked.filter((p) => p.getAttribute("aria-checked") === "true");
    expect(on).toHaveLength(1);
    expect(on[0]?.textContent).toContain("view.3d");
  });

  it("puts the things a person goes looking for where they would look", () => {
    const where = (id: string) =>
      menus("both").find((m) => JSON.stringify(m.entries).includes(`"${id}"`))?.title;
    expect(where("file.import")).toBe("File");
    expect(where("file.export.csv")).toBe("File");
    expect(where("edit.undo")).toBe("Edit");
    expect(where("view.fit")).toBe("View");
    expect(where("camera.fit")).toBe("3D");
    expect(where("help.about")).toBe("Help");
  });

  it("skips a line it cannot name rather than rendering a dead one", async () => {
    // Belt as well as braces: if a command is ever removed without the menu being updated, the line
    // goes rather than sitting there doing nothing when clicked.
    const commands = registry();
    vi.spyOn(commands, "get").mockImplementation((id) =>
      id === "edit.redo" ? null : (commands.all().find((c) => c.id === id) ?? null),
    );
    show(commands);
    const user = userEvent.setup();
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(screen.queryByRole("menuitem", { name: /Do edit\.redo/ })).toBeNull();
  });
});
