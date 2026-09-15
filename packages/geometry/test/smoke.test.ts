import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/geometry", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("geometry");
  });
});
