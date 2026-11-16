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
/** Once. A model that answers with prose twice running means it, and each turn costs a call. */
export const IDLE_GATE_FIRINGS = 1;

export interface GateState {
  /** Times the plan gate has fired since it was last re-armed. */
  planFired: number;
  /** Times the verify gate has fired in this run. */
  verifyFired: number;
  /** Times the idle gate has fired in this run. */
  idleFired: number;
  /** Tools called in this run, loop tools aside. Zero at the end of a step means nothing happened. */
  toolsUsed: number;
  /** A tool that changed the project has run since the last check. */
  unchecked: string[];
}

export function newGateState(): GateState {
  return { planFired: 0, verifyFired: 0, idleFired: 0, unchecked: [], toolsUsed: 0 };
}

/** A tool ran: remember whether it changed anything, and whether it was the check. */
export function afterTool(
  state: GateState,
  name: string,
  ok: boolean,
  sets: { mutating: ReadonlySet<string>; verifying: ReadonlySet<string> },
): GateState {
  // Counted whether or not it worked: a model that tried is not a model that sat still, and the
  // idle gate is about the difference between doing something and describing it.
  const used = { ...state, toolsUsed: state.toolsUsed + 1 };
  if (sets.verifying.has(name)) return { ...used, planFired: 0, unchecked: [] };
  if (ok && sets.mutating.has(name))
    return { ...used, planFired: 0, unchecked: [...new Set([...used.unchecked, name])] };
  // Any tool at all re-arms the plan gate: a model that is still working has not stopped early.
  return { ...used, planFired: 0 };
}

/**
 * A loop tool ran: it counts as having done something, and deliberately does not re-arm the plan
 * gate. plan_work re-arming it would let a model rewrite its plan on every nudge and never finish.
 */
export function afterLoopTool(state: GateState): GateState {
  return { ...state, toolsUsed: state.toolsUsed + 1 };
}

export interface Gate {
  gate: "plan" | "verify" | "idle";
  text: string;
}

/**
 * What to say to a model that has answered without finishing, or null to let the answer stand.
 *
 * One at a time, most specific first: an unfinished job is a bigger thing than an unverified one,
 * and a model told two things at once tends to answer the second. The idle gate is last because its
 * complaint is the vaguest, and either of the others has a better sentence for the same run.
 */
export function gateFor(
  state: GateState,
  plan: readonly PlanItem[],
  options: { plan?: boolean; verify?: boolean; idle?: boolean } = {},
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
  // Last, because it is the least specific: a model with an open plan has already been told the
  // better thing. This is for the run where nothing happened at all -- smaller models answer a brief
  // with what they are about to do, "I will design a one-bedroom flat", and the run ends on the
  // first step having drawn nothing, because an answer with no tool calls is how a run ends.
  //
  // It gives the model an out, because not every request is a brief: somebody who asks what the
  // agent can do deserves an answer, not a tool call, and a gate that cannot tell the difference
  // would turn every conversational turn into a wasted step.
  if (options.idle !== false && state.idleFired < IDLE_GATE_FIRINGS && state.toolsUsed === 0) {
    return {
      gate: "idle",
      text:
        "You answered without calling a single tool, so nothing you described has been done and " +
        "nobody can see it. If you were asked to build or change something, do it now: saying what " +
        "you intend to do is not doing it. If you were only asked a question, answer it and say " +
        "plainly that you have changed nothing.",
    };
  }
  return null;
}

/** The state after a gate has spoken, so each one is bounded. */
export function afterGate(state: GateState, gate: Gate["gate"]): GateState {
  if (gate === "plan") return { ...state, planFired: state.planFired + 1 };
  if (gate === "idle") return { ...state, idleFired: state.idleFired + 1 };
  return { ...state, verifyFired: state.verifyFired + 1 };
}
