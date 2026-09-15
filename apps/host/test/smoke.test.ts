import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/host", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("host");
  });
});
