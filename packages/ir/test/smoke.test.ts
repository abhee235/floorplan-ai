import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/ir", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("ir");
  });
});
