// The command registry (ADR-017 D4 and its consequences): one list of everything the editor can do, with
// each command's title, group, shortcut and whether it applies right now. The palette, the shortcut list
// and the key handler all read from here, so a command cannot exist without being discoverable.
import { type Chord, type KeyLike, matchesChord, parseChord } from "./keys.js";

export interface EditorCommand {
  /** Stable dotted id, e.g. "wall.draw"; also what the palette and tests address. */
  id: string;
  title: string;
  /** The palette's section heading: "Tools", "Walls", "Edit". */
  group: string;
  shortcut?: string;
  /** A short qualifier shown after the title, e.g. "applies to the selection". */
  detail?: string;
  /** Absent means always available. */
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

export interface RegisteredCommand extends EditorCommand {
  /** The parsed shortcut, or null when the command has none. */
  chord: Chord | null;
}

export type RunOutcome = "ran" | "disabled" | "unknown";

export interface CommandMatch {
  command: RegisteredCommand;
  /** Lower is a better match; 0 is a title prefix. */
  score: number;
  /** Half-open ranges of the title the query matched, so the palette can mark them. */
  spans: [number, number][];
}

export class CommandRegistry {
  private readonly order: RegisteredCommand[] = [];
  private readonly index = new Map<string, RegisteredCommand>();

  /** Registers commands in the order they should appear. A repeated id is a mistake, not an override. */
  add(...commands: EditorCommand[]): this {
    for (const command of commands) {
      if (this.index.has(command.id)) throw new Error(`duplicate command ${command.id}`);
      const registered: RegisteredCommand = {
        ...command,
        chord: command.shortcut ? parseChord(command.shortcut) : null,
      };
      this.index.set(command.id, registered);
      this.order.push(registered);
    }
    return this;
  }

  all(): RegisteredCommand[] {
    return [...this.order];
  }

  get(id: string): RegisteredCommand | null {
    return this.index.get(id) ?? null;
  }

  isEnabled(id: string): boolean {
    const command = this.index.get(id);
    return command ? (command.enabled?.() ?? true) : false;
  }

  /** Runs the command if it applies. Returns what happened so the caller can say so out loud. */
  async run(id: string): Promise<RunOutcome> {
    const command = this.index.get(id);
    if (!command) return "unknown";
    if (command.enabled && !command.enabled()) return "disabled";
    await command.run();
    return "ran";
  }

  /** The command a key event fires. Disabled commands are skipped rather than swallowing the key. */
  forKey(event: KeyLike): RegisteredCommand | null {
    for (const command of this.order) {
      if (!command.chord || !matchesChord(command.chord, event)) continue;
      if (command.enabled?.() ?? true) return command;
    }
    return null;
  }

  /** Palette search. An empty query lists everything in registration order. */
  match(query: string): CommandMatch[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.order.map((command) => ({ command, score: 0, spans: [] }));
    const out: CommandMatch[] = [];
    for (const command of this.order) {
      const ranked = rank(command, q);
      if (ranked) out.push({ command, ...ranked });
    }
    // sort is stable, so commands of equal rank keep their registration order
    return out.sort((a, b) => a.score - b.score);
  }
}

/** A title prefix beats a word start, which beats the letters appearing in order, which beats the group. */
function rank(command: RegisteredCommand, q: string): { score: number; spans: [number, number][] } | null {
  const title = command.title.toLowerCase();
  const at = title.indexOf(q);
  if (at === 0) return { score: 0, spans: [[0, q.length]] };
  if (at > 0) return { score: title[at - 1] === " " ? 1 : 2, spans: [[at, at + q.length]] };
  const spans = subsequence(title, q);
  if (spans) return { score: 3, spans };
  return command.group.toLowerCase().includes(q) ? { score: 4, spans: [] } : null;
}

/** Every character of the query in order; returns the ranges they landed on, or null when one is missing. */
function subsequence(text: string, q: string): [number, number][] | null {
  const spans: [number, number][] = [];
  let from = 0;
  for (const ch of q) {
    const found = text.indexOf(ch, from);
    if (found < 0) return null;
    const last = spans[spans.length - 1];
    if (last && last[1] === found) last[1] = found + 1;
    else spans.push([found, found + 1]);
    from = found + 1;
  }
  return spans;
}
