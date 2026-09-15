import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/assets", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("assets");
  });
});
