import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/exporters", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("exporters");
  });
});
