import { VerifyInputError, type VerifyOutcome, type VerifyRequest, VerifyUnavailable } from "@fpv/catalog";
import { describe, expect, it } from "vitest";
import type { ProductVerifier } from "../src/index.js";
import { harness } from "./helpers.js";

const outcome = (over: Partial<VerifyOutcome> = {}): VerifyOutcome => ({
  productId: "samsung-qm75c",
  status: "verified",
  confidence: 0.85,
  product: null,
  sources: ["https://www.samsung.com/qm75c"],
  notes: [],
  cached: false,
  runId: "vrun_1",
  checks: null,
  proposal: null,
  ...over,
});

describe("verify_product tool (spec 04 section 7)", () => {
  it("passes make, model, category, sources, proposal and force through and returns the outcome", async () => {
    const seen: VerifyRequest[] = [];
    const verifier: ProductVerifier = {
      async verify(req) {
        seen.push(req);
        return outcome();
      },
    };
    const h = harness(undefined, { verifier });
    const r = await h.ok("verify_product", {
      make: "Samsung",
      model: "QM75C",
      category: "display",
      sources: ["https://www.samsung.com/qm75c"],
      proposal: { found: true, make: "Samsung", model: "QM75C" },
      force: true,
    });
    expect(r.result).toMatchObject({
      productId: "samsung-qm75c",
      status: "verified",
      sources: ["https://www.samsung.com/qm75c"],
    });
    expect(r.changed).toBeNull();
    expect(seen).toEqual([
      {
        make: "Samsung",
        model: "QM75C",
        category: "display",
        sources: ["https://www.samsung.com/qm75c"],
        proposal: { found: true, make: "Samsung", model: "QM75C" },
        force: true,
      },
    ]);
  });

  it("maps a missing service to unavailable with the hint, and bad input to args.invalid", async () => {
    const unavailable: ProductVerifier = {
      async verify() {
        throw new VerifyUnavailable("no search provider is configured", "pass sources");
      },
    };
    const r = await harness(undefined, { verifier: unavailable }).call("verify_product", {
      make: "A",
      model: "B",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: "unavailable", hint: "pass sources" });
    const invalid: ProductVerifier = {
      async verify() {
        throw new VerifyInputError("sources", "only http and https pages can be read: file:///x");
      },
    };
    const bad = await harness(undefined, { verifier: invalid }).call("verify_product", {
      make: "A",
      model: "B",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.error).toMatchObject({
        code: "args.invalid",
        message: "sources: only http and https pages can be read: file:///x",
      });
    const schema = await harness(undefined, { verifier: invalid }).call("verify_product", {
      make: "A",
      model: "B",
      sources: ["not a url"],
    });
    expect(schema.ok).toBe(false);
  });
});
