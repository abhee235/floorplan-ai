import { describe, expect, it } from "vitest";
import { rovingNext } from "../../src/index.js";

const rail = { count: 8, orientation: "vertical" as const };
const bar = { count: 4, orientation: "horizontal" as const };

describe("one tab stop per toolbar (ADR-017 D4)", () => {
  it("moves along the tool rail with up and down", () => {
    expect(rovingNext(0, "ArrowDown", rail)).toBe(1);
    expect(rovingNext(3, "ArrowUp", rail)).toBe(2);
  });

  it("wraps at either end, so the rail has no dead key", () => {
    expect(rovingNext(7, "ArrowDown", rail)).toBe(0);
    expect(rovingNext(0, "ArrowUp", rail)).toBe(7);
  });

  it("jumps to the ends", () => {
    expect(rovingNext(5, "Home", rail)).toBe(0);
    expect(rovingNext(5, "End", rail)).toBe(7);
  });

  it("leaves keys that are not its own alone", () => {
    // the rail is vertical, so left and right belong to whatever the shell does with them
    expect(rovingNext(2, "ArrowRight", rail)).toBeNull();
    expect(rovingNext(2, "Enter", rail)).toBeNull();
    expect(rovingNext(2, "w", rail)).toBeNull();
  });

  it("moves along a horizontal bar with left and right instead", () => {
    expect(rovingNext(0, "ArrowRight", bar)).toBe(1);
    expect(rovingNext(0, "ArrowLeft", bar)).toBe(3);
    expect(rovingNext(1, "ArrowDown", bar)).toBeNull();
  });

  it("stays put at the end of a group that does not wrap, still consuming the key", () => {
    const options = { ...bar, wrap: false };
    expect(rovingNext(3, "ArrowRight", options)).toBe(3);
    expect(rovingNext(0, "ArrowLeft", options)).toBe(0);
  });

  it("copes with an index out of range and an empty group", () => {
    expect(rovingNext(99, "ArrowUp", rail)).toBe(6);
    expect(rovingNext(-4, "ArrowDown", rail)).toBe(1);
    expect(rovingNext(0, "ArrowDown", { count: 0, orientation: "vertical" })).toBeNull();
  });
});
