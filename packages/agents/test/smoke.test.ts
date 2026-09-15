import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/index.js";

describe("@fpv/agents", () => {
  it("loads", () => {
    expect(PACKAGE).toBe("agents");
  });
});
