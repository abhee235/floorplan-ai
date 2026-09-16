import { describe, expect, it } from "vitest";
import { CommandRegistry, type EditorCommand, type KeyLike } from "../../src/index.js";

const press = (key: string, mods: Partial<Omit<KeyLike, "key">> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

/** The registry under test, plus the ids each command recorded when it ran. */
function registry(overrides: Partial<Record<string, () => boolean>> = {}): {
  commands: CommandRegistry;
  ran: string[];
} {
  const ran: string[] = [];
  const make = (c: Omit<EditorCommand, "run">): EditorCommand => {
    const enabled = overrides[c.id];
    return { ...c, ...(enabled ? { enabled } : {}), run: () => void ran.push(c.id) };
  };
  const commands = new CommandRegistry().add(
    make({ id: "tool.select", title: "Select", group: "Tools", shortcut: "V" }),
    make({ id: "tool.wall", title: "Draw wall", group: "Tools", shortcut: "W" }),
    make({ id: "wall.thickness", title: "Wall thickness…", group: "Walls" }),
    make({ id: "edit.undo", title: "Undo", group: "Edit", shortcut: "Ctrl+Z" }),
    make({ id: "edit.redo", title: "Redo", group: "Edit", shortcut: "Ctrl+Shift+Z" }),
  );
  return { commands, ran };
}

describe("command registry (ADR-017 D4)", () => {
  it("keeps registration order and refuses a repeated id", () => {
    const { commands } = registry();
    expect(commands.all().map((c) => c.id)).toEqual([
      "tool.select",
      "tool.wall",
      "wall.thickness",
      "edit.undo",
      "edit.redo",
    ]);
    expect(() =>
      commands.add({ id: "edit.undo", title: "Undo again", group: "Edit", run: () => {} }),
    ).toThrow(/duplicate command edit.undo/);
  });

  it("parses each shortcut once, at registration", () => {
    const { commands } = registry();
    expect(commands.get("edit.redo")?.chord).toEqual({
      key: "z",
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    });
    expect(commands.get("wall.thickness")?.chord).toBeNull();
    // a misspelled modifier fails here, when the command is registered, rather than at the keyboard
    expect(() =>
      new CommandRegistry().add({ id: "x", title: "X", group: "G", shortcut: "Crtl+K", run: () => {} }),
    ).toThrow(/unknown modifier/);
  });

  it("says what happened when a command is asked to run", async () => {
    const { commands, ran } = registry({ "edit.undo": () => false });
    expect(await commands.run("tool.wall")).toBe("ran");
    expect(await commands.run("edit.undo")).toBe("disabled");
    expect(await commands.run("nothing.here")).toBe("unknown");
    expect(ran).toEqual(["tool.wall"]);
    expect(commands.isEnabled("edit.undo")).toBe(false);
    expect(commands.isEnabled("tool.wall")).toBe(true);
    expect(commands.isEnabled("nothing.here")).toBe(false);
  });
});

describe("shortcuts reach their command", () => {
  it("tells undo and redo apart", () => {
    const { commands } = registry();
    expect(commands.forKey(press("z", { ctrlKey: true }))?.id).toBe("edit.undo");
    expect(commands.forKey(press("Z", { ctrlKey: true, shiftKey: true }))?.id).toBe("edit.redo");
    expect(commands.forKey(press("w"))?.id).toBe("tool.wall");
    expect(commands.forKey(press("q"))).toBeNull();
  });

  it("passes the key on rather than swallowing it for a command that does not apply", () => {
    const { commands } = registry({ "edit.undo": () => false });
    expect(commands.forKey(press("z", { ctrlKey: true }))).toBeNull();
  });
});

describe("palette search", () => {
  it("lists everything for an empty query", () => {
    const { commands } = registry();
    expect(commands.match("  ").map((m) => m.command.id)).toEqual(commands.all().map((c) => c.id));
  });

  it("ranks a title prefix above a word start, and drops what does not match", () => {
    const { commands } = registry();
    const hits = commands.match("wall");
    expect(hits.map((m) => m.command.id)).toEqual(["wall.thickness", "tool.wall"]);
    expect(hits[0]?.score).toBe(0);
    expect(hits[1]?.score).toBe(1);
  });

  it("marks where the query landed, so the palette can highlight it", () => {
    const { commands } = registry();
    const drawWall = commands.match("wall").find((m) => m.command.id === "tool.wall");
    expect(drawWall?.spans).toEqual([[5, 9]]); // "draw |wall|"
  });

  it("finds a command by letters in order, and by its group", () => {
    const { commands } = registry();
    expect(commands.match("dw").map((m) => m.command.id)).toEqual(["tool.wall"]);
    expect(commands.match("edit").map((m) => m.command.id)).toEqual(["edit.undo", "edit.redo"]);
  });
});
