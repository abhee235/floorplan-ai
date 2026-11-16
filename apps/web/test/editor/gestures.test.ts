// What the person did, on its way to the host's log (ADR-019 D4): batched so a burst is one frame,
// never the same line twice running, and dropped rather than kept when there is nowhere to send it.
import { describe, expect, it, vi } from "vitest";
import { GestureLog, recordGesture, setGestureLog } from "../../src/editor/gestures.js";

/** A log whose flush is held until the test asks for it, standing in for the timer. */
function held(): { log: GestureLog; sent: { what: string; detail?: unknown }[][]; tick: () => void } {
  const sent: { what: string; detail?: unknown }[][] = [];
  let due: (() => void) | null = null;
  const log = new GestureLog((gestures) => sent.push(gestures), {
    defer: (flush) => {
      due = flush;
      return () => {
        due = null;
      };
    },
  });
  return {
    log,
    sent,
    tick: () => {
      const run = due;
      due = null;
      run?.();
    },
  };
}

describe("recording what the person did", () => {
  it("sends a burst as one frame, in the order it happened", () => {
    const { log, sent, tick } = held();
    log.record("tool", { tool: "zone" });
    log.record("drag", { phase: "begin", kind: "move" });
    log.record("drag", { phase: "end", kind: "move" });
    expect(sent).toEqual([]); // nothing has gone yet: they travel together
    tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.map((g) => g.what)).toEqual(["tool", "drag", "drag"]);
    expect(sent[0]?.[1]?.detail).toEqual({ phase: "begin", kind: "move" });
  });

  it("does not write the same line twice running", () => {
    const { log, sent, tick } = held();
    log.record("select", { ids: ["item_1"] });
    log.record("select", { ids: ["item_1"] });
    log.record("select", { ids: ["item_2"] });
    tick();
    expect(sent[0]).toHaveLength(2);
    expect(sent[0]?.[1]?.detail).toEqual({ ids: ["item_2"] });
  });

  it("goes at once rather than growing past what a frame may carry", () => {
    const { log, sent, tick } = held();
    for (let i = 0; i < 45; i += 1) log.record("select", { ids: [`item_${i}`] });
    // the first forty went without waiting for the timer
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(40);
    tick();
    expect(sent[1]).toHaveLength(5);
  });

  it("carries on when the bridge throws, because a log is never worth an exception", () => {
    const log = new GestureLog(() => {
      throw new Error("socket closed");
    });
    log.record("tool", { tool: "select" });
    expect(() => log.flush()).not.toThrow();
  });

  it("writes nowhere until the shell has a bridge, and nowhere again once it goes", () => {
    const sent: unknown[][] = [];
    // Before: every component test calls this, with no shell and no socket anywhere.
    expect(() => recordGesture("tool", { tool: "select" })).not.toThrow();
    const log = new GestureLog((g) => sent.push(g));
    setGestureLog(log);
    recordGesture("view", { mode: "3d" });
    log.flush();
    expect(sent).toEqual([[{ what: "view", detail: { mode: "3d" } }]]);
    setGestureLog(null);
    recordGesture("view", { mode: "plan" });
    expect(sent).toHaveLength(1);
  });

  it("puts down what was waiting when the log is changed, rather than losing it", () => {
    const sent: unknown[][] = [];
    const log = new GestureLog((g) => sent.push(g), { defer: () => () => {} });
    setGestureLog(log);
    recordGesture("tool", { tool: "zone" });
    expect(sent).toEqual([]);
    setGestureLog(null);
    expect(sent).toEqual([[{ what: "tool", detail: { tool: "zone" } }]]);
  });

  it("waits on a timer by default, so a real editor sends without being asked", () => {
    vi.useFakeTimers();
    try {
      const sent: unknown[][] = [];
      const log = new GestureLog((g) => sent.push(g));
      log.record("tool", { tool: "wall" });
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(200);
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
