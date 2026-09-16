// Mounts the editor shell, starts the app inside it, and registers the commands that need the bridge.
import { startApp } from "./app.js";
import { mountShell } from "./editor/shell.js";
import { bindWallDrawing } from "./editor/wall-drawing.js";

const root = document.getElementById("app");
if (!root) throw new Error("missing #app");

const shell = mountShell(root);
const app = startApp(shell.slots);
const { client, plan, replica, review } = app;

// The app's frame loop only flushes when it has marked the plan dirty itself, so the editor asks for its
// own repaint, coalesced to one a frame.
let overlayPending = false;
const redraw = (): void => {
  plan.invalidateOverlay();
  if (overlayPending) return;
  overlayPending = true;
  requestAnimationFrame(() => {
    overlayPending = false;
    plan.flush();
  });
};

const wallDrawing = bindWallDrawing({
  plan,
  element: shell.slots.plan,
  announcer: shell.announcer,
  project: () => replica.project,
  settings: () => ({
    thickness: Number(shell.option("wall", "thickness") ?? 100),
    kind: String(shell.option("wall", "kind") ?? "interior"),
    magnetism: shell.option("wall", "snapWalls") !== false,
  }),
  active: () => shell.tool().id === "wall",
  send: async (command) => {
    await client.command(command);
  },
  redraw,
  status: (text) => shell.setSnap(text),
});

// One overlay painter: the draft review panel and the wall preview both draw over the plan.
plan.setOverlayExtra((ctx, view) => {
  review.draw(ctx, view);
  wallDrawing.draw(ctx, view);
});

// Leaving the wall tool ends the chain rather than abandoning it half drawn (W-090).
shell.onTool((tool) => {
  if (tool.id !== "wall") wallDrawing.finish();
});

shell.commands.add(
  {
    id: "edit.undo",
    title: "Undo",
    group: "Edit",
    shortcut: "Ctrl+Z",
    enabled: () => replica.historyPosition >= 0,
    run: async () => {
      await client.undo();
      shell.announcer.say("Undone.");
    },
  },
  {
    id: "edit.redo",
    title: "Redo",
    group: "Edit",
    shortcut: "Ctrl+Shift+Z",
    run: async () => {
      await client.redo();
      shell.announcer.say("Redone.");
    },
  },
  {
    id: "edit.selectNone",
    title: "Select nothing",
    group: "Edit",
    shortcut: "Escape",
    enabled: () => replica.selection.length > 0,
    run: async () => {
      await client.select([]);
      shell.announcer.say("Selection cleared.");
    },
  },
  {
    id: "view.fit",
    title: "Fit the plan to the window",
    group: "View",
    shortcut: "F",
    run: () => {
      plan.fit();
      shell.announcer.say("Plan fitted to the window.");
    },
  },
  {
    id: "view.plan",
    title: "Show the plan only",
    group: "View",
    run: () => shell.setViewMode("plan"),
  },
  {
    id: "view.both",
    title: "Show the plan and the 3D view",
    group: "View",
    run: () => shell.setViewMode("both"),
  },
  {
    id: "view.3d",
    title: "Show the 3D view only",
    group: "View",
    run: () => shell.setViewMode("3d"),
  },
  {
    id: "file.import",
    title: "Import plan…",
    group: "File",
    detail: "a DXF, a PDF or an image",
    run: () => shell.slots.importFile.click(),
  },
);

// the app bar's buttons run the same commands, so there is one path for each
for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-command]")) {
  const id = button.dataset.command as string;
  button.addEventListener("click", () => void shell.commands.run(id));
}

shell.onZoom((factor) => {
  plan.zoomAt(plan.view.width / 2, plan.view.height / 2, factor);
  shell.setScale(plan.view.scale, Math.min(2, window.devicePixelRatio));
});
shell.onLevel((levelId) => plan.setLevel(levelId));

replica.subscribe(({ project }) => {
  shell.setProject(project);
  shell.setProblems(replica.problems);
  shell.setScale(plan.view.scale, Math.min(2, window.devicePixelRatio));
});
