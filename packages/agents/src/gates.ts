// Gates: the reasons a run is not over yet.
//
// A model that has drawn three of fifty rooms and says "I have made a start" has not finished the
// task; a model that has moved twenty walls without once asking whether the drawing is still valid
// has not checked its work. Neither is a failure worth ending a run over — both are worth a sentence
// and another turn.
//
// So a gate is a reminder, never a stop. It is injected as a message the model reads and never shown
// in the chat, it fires a bounded number of times, and it re-arms when the model does something,
// which is what keeps a nudge from becoming a nag. The step budget is still the backstop; these are
// what make reaching it rare. Cascade informed the pattern; no code was taken from it.

import { type PlanItem, planIsOpen } from "./loop-tools.js";

/** How many times each gate may speak in one run before it accepts the model's answer. */
export const PLAN_GATE_FIRINGS = 2;
export const VERIFY_GATE_FIRINGS = 1;

export interface GateState {
  /** Times the plan gate has fired since it was last re-armed. */
  planFired: number;
  /** Times the verify gate has fired in this run. */
  verifyFired: number;
  /** A tool that changed the project has run since the last check. */
  unchecked: string[];
}

export function newGateState(): GateState {
  return { planFired: 0, verifyFired: 0, unchecked: [] };
}

/** A tool ran: remember whether it changed anything, and whether it was the check. */
export function afterTool(
  state: GateState,
  name: string,
  ok: boolean,
  sets: { mutating: ReadonlySet<string>; verifying: ReadonlySet<string> },
): GateState {
  if (sets.verifying.has(name)) return { ...state, planFired: 0, unchecked: [] };
  if (ok && sets.mutating.has(name))
    return { ...state, planFired: 0, unchecked: [...new Set([...state.unchecked, name])] };
  // Any tool at all re-arms the plan gate: a model that is still working has not stopped early.
  return { ...state, planFired: 0 };
}

export interface Gate {
  gate: "plan" | "verify";
  text: string;
}

/**
 * What to say to a model that has answered without finishing, or null to let the answer stand.
 *
 * The plan comes first: an unfinished job is a bigger thing than an unverified one, and a model told
 * both at once tends to answer the second.
 */
export function gateFor(
  state: GateState,
  plan: readonly PlanItem[],
  options: { plan?: boolean; verify?: boolean } = {},
): Gate | null {
  if (options.plan !== false && state.planFired < PLAN_GATE_FIRINGS && planIsOpen(plan)) {
    const open = plan.filter((i) => i.status === "pending" || i.status === "doing");
    return {
      gate: "plan",
      text:
        `Your own plan still has ${open.length} unfinished item${open.length > 1 ? "s" : ""}: ` +
        `${open.map((i) => `"${i.text}"`).join(", ")}. ` +
        "Carry on with the next one, or call plan_work to mark it skipped and say why in your answer.",
    };
  }
  if (options.verify !== false && state.verifyFired < VERIFY_GATE_FIRINGS && state.unchecked.length > 0) {
    return {
      gate: "verify",
      text:
        `You changed the project (${state.unchecked.join(", ")}) without checking it. ` +
        "Call validate, fix anything it reports as an error, and then answer.",
    };
  }
  return null;
}

/** The state after a gate has spoken, so each one is bounded. */
export function afterGate(state: GateState, gate: Gate["gate"]): GateState {
  return gate === "plan"
    ? { ...state, planFired: state.planFired + 1 }
    : { ...state, verifyFired: state.verifyFired + 1 };
}
