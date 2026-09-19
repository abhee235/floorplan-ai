// The menu bar (ADR-017 D1 amendment): File, Edit, View, 3D, Help in the app bar's own row.
//
// Every item is a registered command, named and keyed by its id (ADR-018 D3). Nothing here calls the
// bridge, sets a tool or opens a dialog by itself, so the menu, the palette and the keyboard cannot
// drift apart: an item's title and its shortcut are read off the registry, and a menu that names a
// command the editor does not have fails a test rather than rendering a dead item.
//
// The bar had a dead Export button doing exactly that — `run("file.export")` with no such command
// registered anywhere, so it silently did nothing on every click.

import type { JSX } from "react";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "@/components/ui/menubar";
import type { CommandRegistry } from "./commands.js";
import { useEditor } from "./useEditor.js";

/** One line of a menu. A bare string is a command id; the rest say what else a line can be. */
export type MenuEntry =
  | string
  | { separator: true }
  | { title: string; entries: MenuEntry[] }
  /** A heading over the lines beneath it, as the shadcn menubar puts one over a radio group. */
  | { label: string }
  /** A set of commands where one is the state the editor is in, shown with the mark beside it. */
  | { radio: string[]; current: string };

export interface MenuDefinition {
  title: string;
  entries: MenuEntry[];
}

/**
 * The menus, in order. `current` is filled in per render from the editor's own state, so the View menu
 * shows which mode is on rather than offering three identical-looking lines.
 */
export function menus(view: string): MenuDefinition[] {
  return [
    {
      title: "File",
      entries: [
        "file.import",
        {
          title: "Export",
          entries: ["file.export.csv", "file.export.xlsx", { separator: true }, "file.export.glb"],
        },
      ],
    },
    {
      title: "Edit",
      entries: ["edit.undo", "edit.redo", { separator: true }, "edit.delete", "edit.selectNone"],
    },
    {
      title: "View",
      entries: [
        { label: "Layout" },
        { radio: ["view.plan", "view.both", "view.3d"], current: `view.${view}` },
        { separator: true },
        "view.fit",
        { separator: true },
        "view.commands",
      ],
    },
    {
      title: "3D",
      entries: [
        "camera.fit",
        { separator: true },
        {
          title: "Save a picture",
          entries: ["image.plan", "image.model", "image.eye"],
        },
      ],
    },
    {
      title: "Help",
      entries: ["help.log", { separator: true }, "help.shortcuts", { separator: true }, "help.about"],
    },
  ];
}

/** The command ids every menu names, for the test that holds the menu and the registry together. */
export function menuCommandIds(view = "both"): string[] {
  const out: string[] = [];
  const walk = (entries: MenuEntry[]): void => {
    for (const entry of entries) {
      if (typeof entry === "string") out.push(entry);
      else if ("radio" in entry) out.push(...entry.radio);
      else if ("entries" in entry) walk(entry.entries);
      // a label names nothing and runs nothing
    }
  };
  for (const menu of menus(view)) walk(menu.entries);
  return out;
}

/** A stable key per line, worked out before rendering so no line is keyed by its position alone. */
function keyed(entries: MenuEntry[]): { entry: MenuEntry; key: string }[] {
  let separators = 0;
  return entries.map((entry) => {
    if (typeof entry === "string") return { entry, key: entry };
    if ("separator" in entry) return { entry, key: `separator-${(separators += 1)}` };
    if ("label" in entry) return { entry, key: `label-${entry.label}` };
    if ("radio" in entry) return { entry, key: entry.radio.join("|") };
    return { entry, key: entry.title };
  });
}

function Lines({ entries, commands }: { entries: MenuEntry[]; commands: CommandRegistry }): JSX.Element {
  const run = (id: string) => void commands.run(id);
  // A menu holding a radio or checkbox line indents every other line to match, so the titles form one
  // column rather than stepping in and out around the marks. The shadcn menubar does this with `inset`.
  const inset = entries.some((e) => typeof e === "object" && "radio" in e);
  return (
    <>
      {keyed(entries).map(({ entry, key }) => {
        if (typeof entry === "string") {
          const command = commands.get(entry);
          // A menu naming a command that is not registered would be a dead line, which is the defect
          // this replaces. It is skipped here and caught by a test rather than shown.
          if (!command) return null;
          return (
            <MenubarItem
              key={entry}
              inset={inset}
              disabled={!(command.enabled?.() ?? true)}
              onSelect={() => run(entry)}
            >
              {command.title}
              {command.shortcut ? <MenubarShortcut>{command.shortcut}</MenubarShortcut> : null}
            </MenubarItem>
          );
        }
        if ("separator" in entry) return <MenubarSeparator key={key} />;
        if ("label" in entry)
          return (
            <MenubarLabel key={key} inset={inset}>
              {entry.label}
            </MenubarLabel>
          );
        if ("radio" in entry)
          return (
            <MenubarRadioGroup key={key} value={entry.current}>
              {entry.radio.map((id) => {
                const command = commands.get(id);
                return command ? (
                  <MenubarRadioItem key={id} value={id} onSelect={() => run(id)}>
                    {command.title}
                  </MenubarRadioItem>
                ) : null;
              })}
            </MenubarRadioGroup>
          );
        return (
          <MenubarSub key={key}>
            <MenubarSubTrigger inset={inset}>{entry.title}</MenubarSubTrigger>
            <MenubarSubContent>
              <Lines entries={entry.entries} commands={commands} />
            </MenubarSubContent>
          </MenubarSub>
        );
      })}
    </>
  );
}

export function MainMenu(): JSX.Element {
  const editor = useEditor();
  return (
    <Menubar aria-label="Main menu">
      {menus(editor.view).map((menu) => (
        <MenubarMenu key={menu.title}>
          <MenubarTrigger>{menu.title}</MenubarTrigger>
          <MenubarContent>
            <Lines entries={menu.entries} commands={editor.commands} />
          </MenubarContent>
        </MenubarMenu>
      ))}
    </Menubar>
  );
}
