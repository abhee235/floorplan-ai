// What the person did, sent to the host for the session log (ADR-019 D4).
//
// A list of commands says what changed; a list of gestures says what was being attempted. "Picked the
// cluster tool, dragged its edge, released, zone.modify refused" is a story, and the story is what
// debugging needs — the commands alone leave out the half of it where the answer usually is.
//
// The browser is a replica, so this is one way: nothing waits for an answer, and a gesture that cannot
// be sent is dropped rather than kept. Held over a reconnection it would be written down minutes after
// it happened, under the wrong time, which is worse than not written at all.

/** One thing the person did. `what` names it; `detail` says the rest. */
export interface Gesture {
  what: string;
  detail?: Record<string, unknown>;
}

/** How long gestures wait, so a burst travels as one frame rather than one each. */
const FLUSH_MS = 120;
/** How many may wait; a full queue goes at once rather than growing past what a frame may carry. */
const FULL = 40;

export interface GestureLogOptions {
  /** Schedules a flush and returns what cancels it. A short timer by default. */
  defer?: (flush: () => void) => () => void;
}

const laterByTimer = (flush: () => void): (() => void) => {
  const timer = setTimeout(flush, FLUSH_MS);
  return () => clearTimeout(timer);
};

export class GestureLog {
  private waiting: Gesture[] = [];
  private cancel: (() => void) | null = null;
  private readonly defer: (flush: () => void) => () => void;

  constructor(
    private readonly send: (gestures: Gesture[]) => void,
    options: GestureLogOptions = {},
  ) {
    this.defer = options.defer ?? laterByTimer;
  }

  record(what: string, detail?: Record<string, unknown>): void {
    const gesture: Gesture = detail ? { what, detail } : { what };
    // The same gesture twice running is one gesture. A click inside the selection re-sends the selection
    // it already had, and a line repeating the one above it tells a reader nothing.
    const last = this.waiting[this.waiting.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(gesture)) return;
    this.waiting.push(gesture);
    if (this.waiting.length >= FULL) {
      this.flush();
      return;
    }
    if (!this.cancel) this.cancel = this.defer(() => this.flush());
  }

  flush(): void {
    if (this.cancel) {
      this.cancel();
      this.cancel = null;
    }
    const going = this.waiting;
    this.waiting = [];
    if (going.length === 0) return;
    try {
      this.send(going);
    } catch {
      // a log that throws into the editor would be a log worth turning off
    }
  }
}

/**
 * The log the editor is writing to. There is one editor on a page, and a gesture is a side channel
 * rather than state, so the alternative — threading a sink through every component that can be clicked —
 * would cost more than it is worth. It writes nowhere until the shell has a bridge to write to, which is
 * also what lets every component test go on calling `recordGesture` without arranging anything.
 */
let current = new GestureLog(() => {});

export function recordGesture(what: string, detail?: Record<string, unknown>): void {
  current.record(what, detail);
}

/** Point the editor's gestures at a log, or at nothing. What was waiting for the old one still goes. */
export function setGestureLog(log: GestureLog | null): void {
  current.flush();
  current = log ?? new GestureLog(() => {});
}
