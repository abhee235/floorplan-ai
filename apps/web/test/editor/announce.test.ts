import { describe, expect, it } from "vitest";
import { Announcer, type LiveRegion } from "../../src/index.js";

const regions = (): { polite: LiveRegion; assertive: LiveRegion } => ({
  polite: { textContent: "" },
  assertive: { textContent: "" },
});

describe("live regions (ADR-017 D5)", () => {
  it("says gesture feedback politely and refusals assertively", () => {
    const r = regions();
    const say = new Announcer(r);
    say.say("Wall 3, 4 250 millimetres at 180 degrees.");
    say.alert("Blocked: the door swing crosses this chair.");
    expect(r.polite.textContent).toBe("Wall 3, 4 250 millimetres at 180 degrees.");
    expect(r.assertive.textContent).toBe("Blocked: the door swing crosses this chair.");
  });

  it("repeats itself audibly: an unchanged region is not read out again", () => {
    const r = regions();
    const say = new Announcer(r);
    say.say("Snapped to the end of wall 1.");
    const first = r.polite.textContent;
    say.say("Snapped to the end of wall 1.");
    const second = r.polite.textContent;
    say.say("Snapped to the end of wall 1.");
    const third = r.polite.textContent;
    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
    for (const text of [first, second, third])
      expect((text ?? "").trimEnd()).toBe("Snapped to the end of wall 1.");
  });

  it("coalesces a burst of pointer feedback into one announcement", () => {
    const r = regions();
    const scheduled: (() => void)[] = [];
    const say = new Announcer(r, { defer: (flush) => scheduled.push(flush) });
    say.say("4 100 mm");
    say.say("4 200 mm");
    say.say("4 250 mm");
    expect(r.polite.textContent).toBe("");
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(r.polite.textContent).toBe("4 250 mm");

    // the next burst schedules again
    say.say("4 300 mm");
    expect(scheduled).toHaveLength(2);
    scheduled[1]?.();
    expect(r.polite.textContent).toBe("4 300 mm");
  });

  it("does not make a refusal wait behind deferred feedback", () => {
    const r = regions();
    const scheduled: (() => void)[] = [];
    const say = new Announcer(r, { defer: (flush) => scheduled.push(flush) });
    say.say("4 250 mm");
    say.alert("That wall would have no length.");
    expect(r.assertive.textContent).toBe("That wall would have no length.");
    expect(r.polite.textContent).toBe("");
  });

  it("clears both regions and forgets anything deferred", () => {
    const r = regions();
    const scheduled: (() => void)[] = [];
    const say = new Announcer(r, { defer: (flush) => scheduled.push(flush) });
    say.say("4 250 mm");
    say.alert("Blocked.");
    say.clear();
    scheduled[0]?.();
    expect(r.polite.textContent).toBe("");
    expect(r.assertive.textContent).toBe("");
  });
});
