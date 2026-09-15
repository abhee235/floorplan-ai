import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/importers", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("importers");
  });
});
