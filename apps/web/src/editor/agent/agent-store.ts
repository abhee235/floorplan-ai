// The chat's transcript, built from the host's events (ADR-022).
//
// A pure reducer with no DOM in it, for the same reason the drawing tools keep their rules out of the
// canvas: the interesting decisions here are not about pixels. What counts as one card, when a card
// stops spinning, what happens to a tool that was still running when the run was cancelled, and what
// a tab does when it notices it missed something — all of that is testable in a second.
//
// One rule above the others: only `run.finished` says the work is over. A card that clears the
// working state on anything else makes a two-minute build look finished at the first quiet moment,
// which is the single most misleading thing a chat like this can do.

import type { AgentEventMsg, AgentPlanItem, AgentStateMsg, AgentToolDisplay, ChangeSet } from "@fpv/commands";

export type AgentStatus = "idle" | "running" | "waiting" | "cancelling" | "done";

export type AgentItem =
  | { kind: "user"; id: string; text: string; attachments: { name: string; bytes: number }[]; at: string }
  | { kind: "assistant"; id: string; step: number; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      step: number;
      name: string;
      summary: string;
      status: "running" | "ok" | "error" | "interrupted";
      preview: string;
      error: { code: string; message: string; hint: string | null } | null;
      warnings: string[];
      changed: ChangeSet | null;
      display: AgentToolDisplay | null;
      durationMs: number | null;
    }
  | { kind: "plan"; id: string; items: AgentPlanItem[] }
  | { kind: "notes"; id: string; text: string }
  | {
      kind: "question";
      id: string;
      questionId: string;
      text: string;
      ask: "text" | "choice" | "scale" | "consent";
      options: { id: string; label: string; description?: string }[];
      draftId: string | null;
      /** For "consent": the entities the agent wants to change, so the card can name and show them. */
      ids: string[];
      answered: string | null;
    }
  | {
      kind: "note";
      id: string;
      tone: "warning" | "reminder" | "retry" | "error" | "done" | "compacted";
      text: string;
    };

export interface AgentState {
  available: boolean;
  model: string | null;
  note: string | null;
  runId: string | null;
  status: AgentStatus;
  items: AgentItem[];
  usage: { promptTokens: number; completionTokens: number };
  steps: number;
  /** The checkpoint the run started from, so the chat can offer to take the whole run back. */
  checkpointId: string | null;
  /** The last sequence number folded in; a gap means this tab missed something. */
  lastSeq: number;
  missed: boolean;
}

export function emptyState(): AgentState {
  return {
    available: false,
    model: null,
    note: null,
    runId: null,
    status: "idle",
    items: [],
    usage: { promptTokens: 0, completionTokens: 0 },
    steps: 0,
    checkpointId: null,
    lastSeq: 0,
    missed: false,
  };
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${(counter += 1)}`;

/** Reset the ids between tests, so one test's transcript cannot depend on another's. */
export function resetIds(): void {
  counter = 0;
}

/**
 * The state after one message from the host.
 *
 * Every message goes through here, including the replay a reloading tab is sent, so a rebuilt
 * transcript is the live one by construction rather than by a second implementation that agrees with
 * the first until it does not.
 */
export function reduce(state: AgentState, msg: AgentEventMsg | AgentStateMsg): AgentState {
  if (msg.type === "agent.state") {
    const replayed = msg.replay.reduce((s, m) => reduce(s, m), {
      ...emptyState(),
      available: msg.available,
      model: msg.model,
      note: msg.note,
    });
    return {
      ...replayed,
      available: msg.available,
      model: msg.model,
      note: msg.note,
      // The host says whether a run is still going; the replay alone cannot, because a run in flight
      // has no finished event yet and one that ended before this tab connected has one.
      status: msg.run ? msg.run.status : replayed.status === "running" ? "done" : replayed.status,
      runId: msg.run?.runId ?? replayed.runId,
    };
  }

  // A gap means this tab was not listening for a moment. Saying so is better than a transcript with
  // a hole in it that nobody can see.
  const missed = state.lastSeq > 0 && msg.seq > state.lastSeq + 1;
  const next: AgentState = { ...state, lastSeq: msg.seq, missed: state.missed || missed };
  const event = msg.event;

  switch (event.type) {
    case "run.started": {
      // The tab that typed the message already showed it, so it is not shown again. Matching on the
      // text is enough: the optimistic card is always the last thing in the transcript, put there a
      // moment ago by the person who is reading it.
      const mine = next.items.at(-1);
      const echo = mine?.kind === "user" && mine.text === event.text;
      const card: AgentItem = {
        kind: "user",
        id: echo ? (mine as { id: string }).id : nextId("u"),
        text: event.text,
        attachments: event.attachments.map((a) => ({ name: a.name, bytes: a.bytes })),
        at: event.at,
      };
      return {
        ...next,
        runId: msg.runId,
        status: "running",
        checkpointId: event.checkpointId,
        steps: 0,
        items: echo ? [...next.items.slice(0, -1), card] : [...next.items, card],
      };
    }

    case "step.started":
      return { ...next, steps: event.step };

    case "text.delta": {
      // Deltas gather into one assistant card per step, which is what a person reads as one answer.
      const last = next.items.at(-1);
      if (last?.kind === "assistant" && last.streaming && last.step === event.step)
        return {
          ...next,
          items: [...next.items.slice(0, -1), { ...last, text: last.text + event.text }],
        };
      return {
        ...next,
        items: [
          ...next.items,
          { kind: "assistant", id: nextId("a"), step: event.step, text: event.text, streaming: true },
        ],
      };
    }

    case "reasoning.delta":
      // Not shown. A model's reasoning is not its answer, and a chat that prints both reads as two
      // voices arguing; it is in the run's own file for anyone debugging.
      return next;

    case "message": {
      // The finished text of a step replaces whatever the deltas built: the host's copy is the one
      // that was actually said, and it settles a card that a dropped frame would leave half-written.
      const at = next.items.findIndex((i) => i.kind === "assistant" && i.step === event.step && i.streaming);
      const card: AgentItem = {
        kind: "assistant",
        id: at >= 0 ? (next.items[at] as { id: string }).id : nextId("a"),
        step: event.step,
        text: event.text,
        streaming: false,
      };
      if (at >= 0) return { ...next, items: [...next.items.slice(0, at), card, ...next.items.slice(at + 1)] };
      return { ...next, items: [...next.items, card] };
    }

    case "tool.started":
      return {
        ...next,
        items: [
          ...next.items,
          {
            kind: "tool",
            id: event.id,
            step: event.step,
            name: event.name,
            summary: event.summary,
            status: "running",
            preview: "",
            error: null,
            warnings: [],
            changed: null,
            display: null,
            durationMs: null,
          },
        ],
      };

    case "tool.finished": {
      const at = next.items.findIndex((i) => i.kind === "tool" && i.id === event.id);
      const card: AgentItem = {
        kind: "tool",
        id: event.id,
        step: event.step,
        name: event.name,
        summary: at >= 0 ? (next.items[at] as { summary: string }).summary : event.name,
        status: event.ok ? "ok" : "error",
        preview: event.preview,
        error: event.error,
        warnings: event.warnings,
        changed: event.changed,
        display: event.display ?? null,
        durationMs: event.durationMs,
      };
      if (at >= 0) return { ...next, items: [...next.items.slice(0, at), card, ...next.items.slice(at + 1)] };
      return { ...next, items: [...next.items, card] };
    }

    case "plan.updated": {
      // One plan card, kept where it first appeared: a list that jumps to the bottom every time a job
      // is ticked off drags the transcript around while somebody is reading it.
      const at = next.items.findIndex((i) => i.kind === "plan");
      const card: AgentItem = {
        kind: "plan",
        id: at >= 0 ? (next.items[at] as { id: string }).id : nextId("p"),
        items: event.items,
      };
      if (at >= 0) return { ...next, items: [...next.items.slice(0, at), card, ...next.items.slice(at + 1)] };
      return { ...next, items: [...next.items, card] };
    }

    case "notes.updated": {
      // One notes card, kept where it first appeared, for the same reason as the plan.
      const at = next.items.findIndex((i) => i.kind === "notes");
      const card: AgentItem = {
        kind: "notes",
        id: at >= 0 ? (next.items[at] as { id: string }).id : nextId("n"),
        text: event.text,
      };
      if (at >= 0) return { ...next, items: [...next.items.slice(0, at), card, ...next.items.slice(at + 1)] };
      return { ...next, items: [...next.items, card] };
    }

    case "question":
      return {
        ...next,
        status: "waiting",
        items: [
          ...next.items,
          {
            kind: "question",
            id: nextId("q"),
            questionId: event.id,
            text: event.text,
            ids: event.ids ?? [],
            ask: event.kind,
            options: event.options,
            draftId: event.draftId,
            answered: null,
          },
        ],
      };

    case "question.answered": {
      const at = next.items.findIndex((i) => i.kind === "question" && i.questionId === event.id);
      const said = Object.values(event.answers)[0] ?? "";
      const items =
        at >= 0
          ? next.items.map((i, k) =>
              k === at && i.kind === "question"
                ? {
                    ...i,
                    answered:
                      labelOf(i.options, said) + (event.by === "review" ? " (in the review panel)" : ""),
                  }
                : i,
            )
          : next.items;
      return { ...next, status: next.status === "waiting" ? "running" : next.status, items };
    }

    case "reminder":
      return {
        ...next,
        items: [...next.items, { kind: "note", id: nextId("n"), tone: "reminder", text: event.text }],
      };

    // Said out loud, because the alternative is a conversation that quietly gets shorter behind
    // somebody's back and an agent that seems to have forgotten things for no reason (ADR-025 D1).
    case "compacted":
      return {
        ...next,
        items: [...next.items, { kind: "note", id: nextId("n"), tone: "compacted", text: event.text }],
      };

    case "warning":
      return {
        ...next,
        items: [...next.items, { kind: "note", id: nextId("n"), tone: "warning", text: event.message }],
      };

    case "retry":
      return {
        ...next,
        items: [
          ...next.items,
          {
            kind: "note",
            id: nextId("n"),
            tone: "retry",
            text: `The model did not answer; trying again in ${Math.round(event.waitMs / 100) / 10} s. ${event.error}`,
          },
        ],
      };

    case "context":
      return { ...next, usage: { ...next.usage, promptTokens: event.promptTokens } };

    case "run.finished": {
      // Whatever was still running never will now. A card left spinning for ever is the thing a
      // person notices last and trusts least.
      const items = next.items.map((i) =>
        i.kind === "tool" && i.status === "running" ? { ...i, status: "interrupted" as const } : i,
      );
      const said = endNote(event.reason, event.error);
      return {
        ...next,
        status: "done",
        runId: null,
        steps: event.steps,
        usage: event.usage,
        items: said
          ? [...items, { kind: "note", id: nextId("n"), tone: toneOf(event.reason), text: said }]
          : items,
      };
    }

    default:
      return next;
  }
}

function labelOf(options: { id: string; label: string }[], value: string): string {
  return options.find((o) => o.id === value)?.label ?? value;
}

function toneOf(reason: string): "done" | "error" {
  return reason === "done" ? "done" : "error";
}

/** What to say about a run that did not simply finish; nothing at all when it did. */
function endNote(reason: string, error: string | null): string | null {
  switch (reason) {
    case "done":
      return null;
    case "aborted":
      return "Stopped. What was drawn before you stopped it is still there; use Undo this run to take it back.";
    case "step-budget":
      return "It ran out of steps before finishing. Ask it to carry on, or ask for less at once.";
    case "stalled":
      return `It was going in circles, so it stopped${error ? `: ${error}` : ""}.`;
    case "provider-error":
      return `The model could not be reached${error ? `: ${error}` : ""}.`;
    default:
      return error;
  }
}

/** A store around the reducer, so React can subscribe without the reducer knowing React exists. */
export class AgentStore {
  private current: AgentState = emptyState();
  private readonly listeners = new Set<() => void>();

  get state(): AgentState {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AgentState => this.current;

  handle(msg: AgentEventMsg | AgentStateMsg): void {
    const next = reduce(this.current, msg);
    if (next === this.current) return;
    this.current = next;
    for (const l of this.listeners) l();
  }

  /** What a tab shows while its own message is on its way to the host. */
  said(text: string, attachments: { name: string; bytes: number }[], at: string): void {
    this.current = {
      ...this.current,
      status: "running",
      items: [...this.current.items, { kind: "user", id: nextId("u"), text, attachments, at }],
    };
    for (const l of this.listeners) l();
  }

  /** Says the run is on its way out, so the button can stop offering to stop it twice. */
  cancelling(): void {
    if (this.current.status !== "running" && this.current.status !== "waiting") return;
    this.current = { ...this.current, status: "cancelling" };
    for (const l of this.listeners) l();
  }

  /** A refusal from the host: no run started, so the chat says why rather than waiting for nothing. */
  refused(text: string): void {
    this.current = {
      ...this.current,
      status: "idle",
      items: [...this.current.items, { kind: "note", id: nextId("n"), tone: "error", text }],
    };
    for (const l of this.listeners) l();
  }

  clear(): void {
    this.current = {
      ...emptyState(),
      available: this.current.available,
      model: this.current.model,
      note: this.current.note,
    };
    for (const l of this.listeners) l();
  }
}
