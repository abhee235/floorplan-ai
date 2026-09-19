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
import { when } from "./ProjectDialog.js";
import { useEditor } from "./useEditor.js";

/** One line of a menu. A bare string is a command id; the rest say what else a line can be. */
export type MenuEntry =
  | string
  | { separator: true }
  | { title: string; entries: MenuEntry[] }
  /** A heading over the lines beneath it, as the shadcn menubar puts one over a radio group. */
  | { label: string }
  /** A set of commands where one is the state the editor is in, shown with the mark beside it. */
  | { radio: string[]; current: string }
  /**
   * A submenu whose lines are not commands but data — the projects opened lately.
   *
   * Every other line names a registered command, which is what keeps the menus, the palette and the
   * keyboard from drifting apart. A recent file cannot be one: the list is different on every machine
   * and changes while the app runs. So it is marked as data, the walker that checks the menus against
   * the registry skips it, and it is the only kind of line allowed to be dynamic.
   */
  | { title: string; dynamic: "recent" | "open" };

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
        "file.new",
        "file.open",
        { title: "Open recent", dynamic: "recent" },
        { separator: true },
        "file.save",
        { separator: true },
        "file.close",
        { separator: true },
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
        // Where a desktop application puts "switch windows", because that is where people look.
        { title: "Switch project", dynamic: "open" },
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
      else if ("dynamic" in entry)
        continue; // data, not commands
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
    if ("dynamic" in entry) return { entry, key: `dynamic-${entry.dynamic}` };
    return { entry, key: entry.title };
  });
}

interface LinesProps {
  entries: MenuEntry[];
  commands: CommandRegistry;
  /** The lately-opened projects, for the one dynamic line there is. */
  recent: { projectId: string; name: string; lastOpenedAt: string }[];
  openRecent: (projectId: string) => void;
  /** The projects this host has open, and which of them this tab is looking at (ADR-020 D4). */
  open: { projectId: string; name: string; address: string | null }[];
  currentProject: string;
  switchProject: (projectId: string) => void;
}

function Lines({
  entries,
  commands,
  recent,
  openRecent,
  open,
  currentProject,
  switchProject,
}: LinesProps): JSX.Element {
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
        if ("dynamic" in entry && entry.dynamic === "open")
          return (
            <MenubarSub key={key}>
              {/* Never disabled: there is always at least one project open, and a submenu that greys
                  out when there is only one hides the answer to "what else is open?". */}
              <MenubarSubTrigger inset={inset}>{entry.title}</MenubarSubTrigger>
              <MenubarSubContent className="max-w-[28rem]">
                <MenubarRadioGroup value={currentProject}>
                  {open.map((o) => (
                    <MenubarRadioItem
                      key={o.projectId}
                      value={o.projectId}
                      onSelect={() => switchProject(o.projectId)}
                    >
                      <span className="truncate">{o.name}</span>
                      {o.address === null ? (
                        <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">not saved</span>
                      ) : null}
                    </MenubarRadioItem>
                  ))}
                </MenubarRadioGroup>
              </MenubarSubContent>
            </MenubarSub>
          );
        if ("dynamic" in entry)
          return (
            <MenubarSub key={key}>
              <MenubarSubTrigger inset={inset} disabled={recent.length === 0}>
                {entry.title}
              </MenubarSubTrigger>
              <MenubarSubContent className="max-w-[28rem]">
                {recent.map((r) => (
                  // The name, and when it was last open. No path: a person picks a project by what it
                  // is called and when they last touched it, not by where a machine keeps it (ADR-021).
                  <MenubarItem
                    key={r.projectId}
                    className="flex-col items-start gap-0"
                    onSelect={() => openRecent(r.projectId)}
                  >
                    <span className="w-full truncate">{r.name}</span>
                    <span className="w-full truncate text-[11px] text-muted-foreground">
                      {when(r.lastOpenedAt)}
                    </span>
                  </MenubarItem>
                ))}
              </MenubarSubContent>
            </MenubarSub>
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
              <Lines
                entries={entry.entries}
                commands={commands}
                recent={recent}
                openRecent={openRecent}
                open={open}
                currentProject={currentProject}
                switchProject={switchProject}
              />
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
            <Lines
              entries={menu.entries}
              commands={editor.commands}
              recent={editor.recent}
              openRecent={editor.openRecent}
              open={editor.open}
              currentProject={editor.currentProject}
              switchProject={editor.switchProject}
            />
          </MenubarContent>
        </MenubarMenu>
      ))}
    </Menubar>
  );
}
