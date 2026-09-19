// Two tools the loop answers itself: the plan the model keeps, and the question it asks.
//
// Neither touches the project, which is why they are here rather than in the registry: one is the
// model's own working memory and the other is a conversation with a person. The registry's tools all
// mean "change or read the drawing", and putting these beside them would blur that.
//
// A plan matters more than it looks for a long build. "Three storeys, fifty rooms, tinted windows on
// the outside" is a dozen jobs; a model that holds them only in its context loses the last few when
// the conversation is compacted, and a model that has written them down can be asked why it stopped.
// Cascade informed this pair -- a plan tool with invariants, and a question that parks the loop on a
// promise; no code was taken from it.

import type { ToolSpec } from "./provider.js";

export type PlanStatus = "pending" | "doing" | "done" | "skipped";

export interface PlanItem {
  id: string;
  text: string;
  status: PlanStatus;
}

export const PLAN_WORK = "plan_work";
export const ASK_USER = "ask_user";

/** Both are answered inside the loop; the registry never sees them. */
export const LOOP_TOOL_NAMES: ReadonlySet<string> = new Set([PLAN_WORK, ASK_USER]);

export const PLAN_WORK_SPEC: ToolSpec = {
  name: PLAN_WORK,
  description:
    "Write down the jobs this task needs, and keep the list current. Send the whole list every time: items you leave out are taken to be dropped, which is refused unless you mark them skipped. Exactly one item may be 'doing'. Use it for anything with more than two steps, mark an item 'done' as soon as it is, and say why with 'skipped' rather than quietly leaving something out.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "keep an item's id to keep its identity" },
            text: { type: "string", description: "the job, in a few words, e.g. 'draw the outer walls'" },
            status: { type: "string", enum: ["pending", "doing", "done", "skipped"] },
          },
          required: ["text", "status"],
        },
      },
    },
    required: ["items"],
  },
};

export const ASK_USER_SPEC: ToolSpec = {
  name: ASK_USER,
  description:
    "Ask the person a question and wait for the answer. Use it when a choice changes what gets built and you cannot reasonably decide — a plan's scale, which room they meant, a size they alone know — and always with kind 'consent' before you change anything they made or altered themselves, naming the ids. Do not use it to report progress or to ask permission to carry on with your own work.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "one question, in a sentence" },
      kind: {
        type: "string",
        enum: ["text", "choice", "scale", "consent"],
        description:
          "'choice' offers options, 'scale' asks about an imported plan's units, 'consent' asks leave to change the entities in 'ids'",
      },
      options: {
        type: "array",
        description: "for kind 'choice'",
        items: {
          type: "object",
          properties: { id: { type: "string" }, label: { type: "string" }, description: { type: "string" } },
          required: ["id", "label"],
        },
      },
      draftId: { type: "string", description: "for kind 'scale': the draft being reviewed" },
      ids: {
        type: "array",
        description: "for kind 'consent': the entity ids you want to change",
        items: { type: "string" },
      },
    },
    required: ["question"],
  },
};

export interface AskRequest {
  id: string;
  question: string;
  kind: "text" | "choice" | "scale" | "consent";
  options: { id: string; label: string; description?: string }[];
  draftId: string | null;
  /** For kind "consent": what the model is asking leave to change (ADR-023 D3). */
  ids: string[];
}

export type PlanResult =
  | { ok: true; items: PlanItem[]; summary: string }
  | { ok: false; error: string; hint: string };

/**
 * The plan after a model rewrites it, or a refusal saying what is wrong with the new list.
 *
 * The list is replaced whole, which is the only shape a model gets right reliably -- a patch language
 * for a to-do list is one more thing to get wrong. That makes dropping an item the easy mistake, so
 * an unfinished item that disappears is refused by name: a job silently abandoned is exactly what a
 * written plan exists to prevent.
 */
export function applyPlan(current: readonly PlanItem[], raw: unknown): PlanResult {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return { ok: false, error: "items must be a list", hint: "send the whole list" };
  if (items.length > 60)
    return { ok: false, error: `a plan of ${items.length} items is too long`, hint: "group the work" };

  const next: PlanItem[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of items.entries()) {
    const e = entry as { id?: unknown; text?: unknown; status?: unknown };
    const text = typeof e.text === "string" ? e.text.trim() : "";
    if (!text) return { ok: false, error: `item ${i + 1} has no text`, hint: "say what the job is" };
    const status = e.status as PlanStatus;
    if (!["pending", "doing", "done", "skipped"].includes(status))
      return {
        ok: false,
        error: `item ${i + 1} has status "${String(e.status)}"`,
        hint: "status is pending, doing, done or skipped",
      };
    // An id the model kept is the item's identity; anything else gets one, so the editor can follow
    // a single job through a rewrite rather than redrawing the whole card.
    const id = typeof e.id === "string" && e.id.trim() ? e.id.trim() : `p${i + 1}`;
    if (seen.has(id)) return { ok: false, error: `two items share the id "${id}"`, hint: "ids are unique" };
    seen.add(id);
    next.push({ id, text, status });
  }

  const doing = next.filter((i) => i.status === "doing");
  if (doing.length > 1)
    return {
      ok: false,
      error: `${doing.length} items are "doing" at once`,
      hint: "one job at a time; the others are pending",
    };

  const lost = current
    .filter((c) => c.status === "pending" || c.status === "doing")
    .filter((c) => !seen.has(c.id));
  if (lost.length > 0)
    return {
      ok: false,
      error: `the list drops ${lost.length} unfinished item${lost.length > 1 ? "s" : ""}: ${lost
        .map((l) => `"${l.text}"`)
        .join(", ")}`,
      hint: "send every item; mark one skipped rather than leaving it out",
    };

  return { ok: true, items: next, summary: describePlan(next) };
}

/** What the plan says in one line, for the model's own tool result. */
export function describePlan(items: readonly PlanItem[]): string {
  const done = items.filter((i) => i.status === "done").length;
  const skipped = items.filter((i) => i.status === "skipped").length;
  const doing = items.find((i) => i.status === "doing");
  const parts = [`${done} of ${items.length} done`];
  if (skipped) parts.push(`${skipped} skipped`);
  parts.push(doing ? `now: ${doing.text}` : "nothing in hand");
  return parts.join(", ");
}

/** Whether any job is still waiting, which is what the plan gate asks. */
export function planIsOpen(items: readonly PlanItem[]): boolean {
  return items.some((i) => i.status === "pending" || i.status === "doing");
}

/** The plan as the system prompt carries it, so it survives anything done to the conversation. */
export function planForPrompt(items: readonly PlanItem[]): string {
  if (items.length === 0) return "";
  const mark = { pending: "[ ]", doing: "[>]", done: "[x]", skipped: "[-]" } as const;
  return `\n\nThe plan you wrote, as it stands:\n${items
    .map((i) => `${mark[i.status]} ${i.text}`)
    .join("\n")}`;
}

export type AskResult = { ok: true; request: AskRequest } | { ok: false; error: string; hint: string };

export function parseAsk(raw: unknown, id: string): AskResult {
  const a = (raw ?? {}) as {
    question?: unknown;
    kind?: unknown;
    options?: unknown;
    draftId?: unknown;
    ids?: unknown;
  };
  const question = typeof a.question === "string" ? a.question.trim() : "";
  if (!question) return { ok: false, error: "there is no question", hint: "ask one question, in a sentence" };
  const kind = a.kind === "choice" || a.kind === "scale" || a.kind === "consent" ? a.kind : "text";
  const ids = Array.isArray(a.ids) ? a.ids.filter((x): x is string => typeof x === "string") : [];
  if (kind === "consent" && ids.length === 0)
    return {
      ok: false,
      error: "a consent question has to name what it is asking about",
      hint: "pass ids: the entities you want to change",
    };
  const options = Array.isArray(a.options)
    ? a.options.flatMap((o) => {
        const x = o as { id?: unknown; label?: unknown; description?: unknown };
        if (typeof x.id !== "string" || typeof x.label !== "string") return [];
        return [
          {
            id: x.id,
            label: x.label,
            ...(typeof x.description === "string" ? { description: x.description } : {}),
          },
        ];
      })
    : [];
  if (kind === "choice" && options.length < 2)
    return {
      ok: false,
      error: "a choice needs at least two options",
      hint: "give options, or use kind 'text'",
    };
  return {
    ok: true,
    request: {
      id,
      question,
      kind,
      options,
      draftId: typeof a.draftId === "string" ? a.draftId : null,
      ids,
    },
  };
}

/** What the model is told after a person answers. */
export function answerText(request: AskRequest, answers: Record<string, string>): string {
  const given = answers[request.id] ?? answers.answer ?? Object.values(answers)[0] ?? "";
  if (!given) return "The person did not answer; decide for yourself and say what you assumed.";
  if (request.kind === "consent") {
    if (given === CONSENT_NO)
      return `The person said to leave ${request.ids.join(", ")} as they are. Work round them and say so in your answer.`;
    if (given === CONSENT_NONE)
      return "The person said to leave everything of theirs alone for the rest of this run. Change only what you made yourself.";
    return `The person agreed: you may change ${request.ids.join(", ")} in this run.`;
  }
  const chosen = request.options.find((o) => o.id === given);
  return `The person answered: ${chosen ? chosen.label : given}`;
}

/** The three answers a consent question takes (ADR-023 D3). */
export const CONSENT_YES = "yes";
export const CONSENT_NO = "no";
export const CONSENT_NONE = "none";

/** The options a consent question offers, so every tab draws the same three. */
export const CONSENT_OPTIONS: { id: string; label: string; description?: string }[] = [
  { id: CONSENT_YES, label: "Change them" },
  { id: CONSENT_NO, label: "Leave them as they are" },
  {
    id: CONSENT_NONE,
    label: "Leave all my work alone",
    description: "for the rest of this run, so you are not asked again",
  },
];
