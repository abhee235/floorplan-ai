import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/catalog", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("catalog");
  });
});
