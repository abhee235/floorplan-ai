// The editor's non-React state, held once and handed to the chrome through context (ADR-018 D3 and D4).
//
// The command registry, the announcer and the tool definitions are plain TypeScript modules that survived
// the move to React untouched, and they keep their own tests. This is the seam: React reads them, and the
// canvas keeps talking to them directly.
import { createContext, useContext } from "react";
import type { Announcer } from "./announce.js";
import type { CommandRegistry } from "./commands.js";
import type { ToolDefinition, ToolId } from "./tools.js";

export type ViewMode = "plan" | "both" | "3d";

/** What the whole chrome can reach. Nothing here is React state except through the setters. */
export interface Editor {
  commands: CommandRegistry;
  announcer: Announcer;
  tool: ToolDefinition;
  setTool: (id: ToolId) => void;
  view: ViewMode;
  setView: (mode: ViewMode) => void;
  /** The current value of one of a tool's options, from the options bar. */
  option: (toolId: ToolId, optionId: string) => string | number | boolean | undefined;
  setOption: (toolId: ToolId, optionId: string, value: string | number | boolean) => void;
  /** Opens the command palette. */
  openPalette: () => void;
  /** The projects this installation has opened lately, for File ▸ Open recent (ADR-020 D1). */
  recent: { projectId: string; name: string; lastOpenedAt: string }[];
  /** Opens one of them by id; there are no paths anywhere in the editor (ADR-021). */
  openRecent: (projectId: string) => void;
  /** Every project this host has open (ADR-020 D4), for the switcher. */
  open: { projectId: string; name: string; address: string | null }[];
  /** Which of them this tab is looking at. */
  currentProject: string;
  /** Look at another of them; nothing is closed and nothing is lost. */
  switchProject: (projectId: string) => void;
  /** What a snap caught, or what is being drawn, for the status bar. */
  snap: string;
  setSnap: (text: string) => void;
  /** Where the pointer is on the plan, in millimetres. */
  pointer: { x: number; y: number } | null;
  setPointer: (at: { x: number; y: number } | null) => void;
  /** The drawing scale, as pixels per millimetre from the plan renderer. */
  scale: number;
  setScale: (pixelsPerMm: number) => void;
}

export const EditorContext = createContext<Editor | null>(null);

/** Throws rather than returning null: a chrome component outside the provider is a wiring mistake. */
export function useEditor(): Editor {
  const editor = useContext(EditorContext);
  if (!editor) throw new Error("useEditor was called outside the editor provider");
  return editor;
}
