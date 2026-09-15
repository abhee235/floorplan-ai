import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/tools", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("tools");
  });
});
