// @vitest-environment jsdom
// Drawing by typing: the card both drawing tools share (P3-9, ADR-017 D4).
//
// The rules for what a typed length and angle MEAN live in wall-tool.ts and room-tool.ts and are tested
// there. This is the card itself: what it offers, when it refuses to overwrite what somebody is typing,
// and the one piece of state that decides whether Enter places or ends.
import { beforeEach, describe, expect, it } from "vitest";
import { keepInside, mountTypedEntry, screenOffset, type TypedTool } from "../../src/editor/typed-entry.js";

function aTool(over: Partial<TypedTool> = {}): TypedTool {
  return {
    drawing: true,
    points: [{}, {}],
    seed: () => ({ lengthMm: 3000, angleDeg: 270 }),
    ...over,
  };
}

const fields = (el: HTMLElement) => ({
  length: el.querySelector('input[aria-label="Length in mm"]') as HTMLInputElement,
  angle: el.querySelector('input[aria-label="Angle in degrees"]') as HTMLInputElement,
});

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
});

describe("the card", () => {
  it("offers the tool's own seed, and hides when nothing is being drawn", () => {
    const entry = mountTypedEntry(host, { tool: "wall" });
    entry.show(aTool(), { x: 100, y: 50 });
    const { length, angle } = fields(host);
    expect(length.value).toBe("3000");
    expect(angle.value).toBe("270");
    expect(entry.values()).toEqual({ lengthMm: 3000, angleDeg: 270 });

    entry.show(aTool({ drawing: false }), null);
    expect((host.querySelector(".fpv-typed-entry") as HTMLElement).hidden).toBe(true);
    entry.destroy();
  });

  it("says whether the angle turns from the last segment or is measured from the axis", () => {
    const entry = mountTypedEntry(host, { tool: "room" });
    entry.show(aTool({ points: [{}] }), null);
    expect(host.textContent).toContain("measured from the x axis");
    entry.show(aTool({ points: [{}, {}] }), null);
    expect(host.textContent).toContain("relative to the last side");
    entry.destroy();
  });

  it("never overwrites a number while it is being typed", () => {
    const entry = mountTypedEntry(host, { tool: "wall" });
    entry.show(aTool(), null);
    const { length } = fields(host);
    length.focus();
    length.value = "1234";
    // the tool would offer 3000 again; the person is mid-word and the seed is an offer, not a correction
    entry.show(aTool(), null);
    expect(length.value).toBe("1234");
    expect(entry.focused()).toBe(true);
    entry.destroy();
  });

  it("sits beside its anchor", () => {
    const entry = mountTypedEntry(host, { tool: "wall" });
    entry.show(aTool(), { x: 200, y: 120 });
    const card = host.querySelector(".fpv-typed-entry") as HTMLElement;
    // jsdom measures every element as zero, which reads as "not laid out yet": the card is placed down
    // and right of the anchor, where the segment being drawn is not.
    expect(card.style.left).toBe("212px");
    expect(card.style.top).toBe("132px");
    entry.destroy();
  });

  it("never hangs off the plan, which clips it and puts the fields out of reach", () => {
    const plan = { width: 800, height: 600 };
    const card = { width: 180, height: 110 };
    // room to the lower right: beside the anchor
    expect(keepInside({ x: 100, y: 100 }, card, plan)).toEqual({ x: 112, y: 112 });
    // against the right edge: it flips to the other side rather than going past it
    expect(keepInside({ x: 780, y: 100 }, card, plan).x).toBe(780 - 12 - 180);
    // against the bottom edge: the same, upward
    expect(keepInside({ x: 100, y: 580 }, card, plan).y).toBe(580 - 12 - 110);
    // and a corner flips both ways at once
    expect(keepInside({ x: 795, y: 595 }, card, plan)).toEqual({ x: 603, y: 473 });
  });

  it("pins a card to the edge when there is no room on either side of the anchor", () => {
    // an anchor off the plan entirely, which a pan can produce mid-chain
    const at = keepInside({ x: -400, y: -400 }, { width: 180, height: 110 }, { width: 800, height: 600 });
    expect(at).toEqual({ x: 4, y: 4 });
    // a plan with no measured size has not been laid out; the card stays beside its anchor
    expect(keepInside({ x: 50, y: 60 }, { width: 180, height: 110 }, { width: 0, height: 0 })).toEqual({
      x: 62,
      y: 72,
    });
    // and a card larger than the plan is still reachable rather than centred out of view
    const big = keepInside({ x: 10, y: 10 }, { width: 900, height: 700 }, { width: 800, height: 600 });
    expect(big).toEqual({ x: 4, y: 4 });
  });

  it("puts device pixels into CSS pixels, so the card lands beside the anchor on any display", () => {
    expect(screenOffset({ x: 200, y: 100 }, 2)).toEqual({ x: 100, y: 50 });
    expect(screenOffset({ x: 200, y: 100 }, 1)).toEqual({ x: 200, y: 100 });
  });
});

describe("whether Enter places or ends (ADR-017 D4)", () => {
  it("only ends on a second Enter with nothing in between", () => {
    const entry = mountTypedEntry(host, { tool: "wall" });
    // the first Enter after anything else places
    expect(entry.repeatedEnter()).toBe(false);
    // a second, with nothing changed, ends
    expect(entry.repeatedEnter()).toBe(true);
    entry.destroy();
  });

  it("is not cleared by the placement its own Enter caused", () => {
    // The Enter that places a segment IS the first Enter of the pair. Clearing on every placement made
    // a bare Enter place another segment at the seeded length instead of ending, so a chain could never
    // be ended from the keyboard at all -- found by typing a room in a browser, not by any test here.
    const entry = mountTypedEntry(host, { tool: "wall" });
    const { length } = fields(host);
    entry.show(aTool(), null);
    length.value = "4000";
    length.dispatchEvent(new Event("input", { bubbles: true }));
    expect(entry.repeatedEnter()).toBe(false); // this one places
    expect(entry.repeatedEnter()).toBe(true); // and this one ends the chain
    entry.destroy();
  });

  it("forgets it the moment anything else happens", () => {
    const entry = mountTypedEntry(host, { tool: "wall" });
    expect(entry.repeatedEnter()).toBe(false);
    entry.touched(); // a corner placed, the pointer moved, a segment taken back
    expect(entry.repeatedEnter()).toBe(false);
    entry.destroy();
  });

  it("counts typing as something happening: a chain being drawn cannot end by accident", () => {
    const entry = mountTypedEntry(host, { tool: "wall" });
    entry.show(aTool(), null);
    const { length } = fields(host);
    expect(entry.repeatedEnter()).toBe(false);
    length.value = "4200";
    length.dispatchEvent(new Event("input", { bubbles: true }));
    expect(entry.repeatedEnter()).toBe(false);
    entry.destroy();
  });
});

describe("pointer presses on the card", () => {
  it("knows its own nodes, so pressing a field is not a press on the plan", () => {
    const entry = mountTypedEntry(host, { tool: "wall" });
    entry.show(aTool(), null);
    const { length } = fields(host);
    expect(entry.contains(length)).toBe(true);
    expect(entry.contains(host)).toBe(false);
    expect(entry.contains(null)).toBe(false);
    entry.destroy();
  });

  it("hands the keyboard back to the plan when it hides", () => {
    // A hidden input keeps its focus, and the shell reads a focused field as typing: leaving it there
    // meant the shortcut after a finished chain was swallowed by a box nobody could see.
    host.tabIndex = 0;
    const entry = mountTypedEntry(host, { tool: "wall" });
    entry.show(aTool(), null);
    const { length } = fields(host);
    length.focus();
    expect(document.activeElement).toBe(length);
    entry.hide();
    expect(document.activeElement).toBe(host);
    entry.destroy();
  });

  it("takes itself away when the binding is torn down", () => {
    const entry = mountTypedEntry(host, { tool: "wall" });
    expect(host.querySelector(".fpv-typed-entry")).not.toBeNull();
    entry.destroy();
    expect(host.querySelector(".fpv-typed-entry")).toBeNull();
  });
});
