import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/commands", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("commands");
  });
});
