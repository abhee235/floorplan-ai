import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/web", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("web");
  });
});
