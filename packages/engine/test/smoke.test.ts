import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/engine", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("engine");
  });
});
