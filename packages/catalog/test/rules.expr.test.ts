import { describe, expect, it } from "vitest";
import {
  AV_CORE,
  AV_CORE_INPUT,
  type ExprScope,
  type ExprValue,
  evalCondition,
  evalNumber,
  mergePacks,
  parseExpr,
  RulesPack,
  validatePack,
} from "../src/index.js";

/** A scope with a few facts and a call log, for testing the language on its own. */
function scope(facts: Record<string, ExprValue> = {}): ExprScope & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ident(name) {
      if (name in facts) return facts[name] as ExprValue;
      throw new Error(`unknown identifier ${name}`);
    },
    call(name, args) {
      calls.push(name);
      if (name === "count") return args[0] === "chair" ? 10 : 0;
      throw new Error(`unknown function ${name}`);
    },
  };
}

const n = (src: string, s = scope()) => {
  const r = evalNumber(src, s);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const c = (src: string, s = scope()) => {
  const r = evalCondition(src, s);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("expression language (spec 07 section 2)", () => {
  it("precedence: * and / bind tighter than + and -, left to right, parentheses override", () => {
    expect(n("1 + 2 * 3")).toBe(7);
    expect(n("(1 + 2) * 3")).toBe(9);
    expect(n("10 - 4 - 3")).toBe(3);
    expect(n("24 / 4 / 2")).toBe(3);
    expect(n("2 * 3 + 4 * 5")).toBe(26);
  });

  it("max and min, which the core pack's display steps have used since they were written", () => {
    expect(n("max(75, ceil(60.2))")).toBe(75);
    expect(n("max(1, 2, 3)")).toBe(3);
    expect(n("min(4, 2, 9)")).toBe(2);
  });

  it("unary minus, decimals and exponents", () => {
    expect(n("-3 + 5")).toBe(2);
    expect(n("--2")).toBe(2);
    expect(n("2 * -3")).toBe(-6);
    expect(n(".5 + 1.25")).toBe(1.75);
    expect(n("1e3 + 1")).toBe(1001);
  });

  it("conditions: comparisons, and binds tighter than or, not, in lists, strings and booleans", () => {
    expect(c("1 < 2 and 3 > 4 or 5 == 5")).toBe(true);
    expect(c("not 1 == 2")).toBe(true);
    expect(c("room.purpose in ('meeting', 'boardroom')", scope({ "room.purpose": "boardroom" }))).toBe(true);
    expect(c("room.purpose in ('meeting')", scope({ "room.purpose": "cafeteria" }))).toBe(false);
    expect(c("poe == true", scope({ poe: true }))).toBe(true);
    expect(c("type == 'HDMI'", scope({ type: "HDMI" }))).toBe(true);
    expect(c("0.1 + 0.2 == 0.3")).toBe(true);
    expect(c("3 >= 3 and 3 <= 3 and 2 != 3")).toBe(true);
  });

  it("and and or short-circuit, and if evaluates only the branch it takes", () => {
    const s = scope();
    expect(c("1 == 2 and count('x') > 0", s)).toBe(false);
    expect(c("1 == 1 or count('x') > 0", s)).toBe(true);
    expect(s.calls).toEqual([]);
    expect(n("if(count('chair') > 4, 2, 1 / 0)", s)).toBe(2);
  });

  it("built-in functions: rounding, clamp, roundUpTo, roundUpToAny, has, abs, tan", () => {
    expect(n("ceil(10 / 4)")).toBe(3);
    expect(n("ceil(8 / 4)")).toBe(2);
    expect(n("floor(9.99)")).toBe(9);
    expect(n("clamp(12, 0, 10)")).toBe(10);
    expect(n("roundUpTo(7100, 500)")).toBe(7500);
    const stock = scope({ stock: [1000, 5000, 3000] });
    expect(n("roundUpToAny(2999, stock)", stock)).toBe(3000);
    expect(n("roundUpToAny(3000, stock)", stock)).toBe(3000);
    expect(c("has('200x200, 400x400', '400x400')")).toBe(true);
    expect(c("has('200x200,400x400', '600x400')")).toBe(false);
    expect(n("abs(-4)")).toBe(4);
    expect(n("tan(45)")).toBeCloseTo(1, 9);
    expect(n("count('chair')", scope())).toBe(10);
  });

  it("errors are values, never crashes: unknown identifier, division by zero, types, syntax", () => {
    expect(evalNumber("capacity * 2", scope())).toEqual({ ok: false, error: "unknown identifier capacity" });
    expect(evalNumber("4 / (2 - 2)", scope())).toEqual({
      ok: false,
      error: "division by zero: expression is 0",
    });
    expect(evalNumber("'a' + 1", scope())).toMatchObject({ ok: false, error: "'a' is not a number" });
    expect(evalCondition("1 + 1", scope())).toMatchObject({ ok: false });
    expect(evalNumber("roundUpToAny(20000, stock)", scope({ stock: [1000, 5000] }))).toEqual({
      ok: false,
      error: "20000 is longer than the longest value 5000",
    });
    expect(evalNumber("1 +", scope())).toMatchObject({ ok: false });
    expect(evalNumber("(1 + 2", scope())).toMatchObject({
      ok: false,
      error: expect.stringContaining('expected ")"'),
    });
    expect(evalNumber("1 $ 2", scope())).toMatchObject({ ok: false, error: 'unexpected "$" at 2' });
    expect(evalNumber("nope(1)", scope())).toEqual({ ok: false, error: "unknown function nope" });
    expect(() => parseExpr("'open")).toThrow("unterminated string");
  });
});

describe("rules packs (spec 07 section 1)", () => {
  it("the core pack is valid: nine BOM rules, the design rules, every expression parses", () => {
    const { pack, problems } = validatePack(AV_CORE_INPUT);
    expect(problems).toEqual([]);
    expect(pack?.bomRules.map((r) => r.id)).toEqual([
      "display-mount",
      "display-hdmi",
      "bar-usb",
      "speaker-amp",
      "mic-dsp",
      "network-ports",
      "scheduler",
      "table-power",
      "commissioning",
    ]);
    expect(AV_CORE.bomRules.find((r) => r.id === "commissioning")?.enabled).toBe(false);
    expect(AV_CORE.designRules.map((r) => r.id)).toEqual([
      "display-size-detail",
      "display-size-video",
      "camera-fov",
      "ceiling-mic-coverage",
      "ceiling-speaker-coverage",
      "chair-clearance",
      "door-swing-clear",
      "display-centre-height",
    ]);
  });

  it("reports bad expressions, duplicate ids and rules that add nothing", () => {
    const bad = {
      ...AV_CORE_INPUT,
      bomRules: [
        {
          kind: "scope",
          id: "x",
          scope: "room",
          when: "count('display' > 0",
          add: { category: "other" },
          quantity: "1",
          unit: "each",
        },
        { kind: "scope", id: "x", scope: "room", when: null, add: {}, quantity: "1", unit: "each" },
      ],
      designRules: [],
    };
    const { problems } = validatePack(bad);
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringContaining("when:"),
      "duplicate bom rule id x",
      "add needs a productId, a category or a description",
    ]);
    expect(validatePack({ id: "Bad Id" }).pack).toBeNull();
  });

  it("a user pack overlays the base by id: replaces in place, disables, appends, merges facts", () => {
    const user = RulesPack.parse({
      id: "my-office",
      version: "0.1.0",
      name: "My office",
      extends: "av-core",
      facts: { cableSlackMm: 1500, labourRate: 95 },
      bomRules: [
        { ...AV_CORE_INPUT.bomRules?.find((r) => r.id === "commissioning"), enabled: true },
        {
          kind: "scope",
          id: "cleanup",
          scope: "project",
          when: null,
          add: { description: "Site clean" },
          quantity: "1",
          unit: "set",
        },
      ],
      designRules: [
        { ...AV_CORE_INPUT.designRules?.find((r) => r.id === "chair-clearance"), enabled: false },
      ],
    });
    const merged = mergePacks(AV_CORE, user);
    expect(merged.id).toBe("my-office");
    expect(merged.extends).toBe("av-core");
    expect(merged.facts.cableSlackMm).toBe(1500);
    expect(merged.facts.chairClearanceMm).toBe(900);
    expect(merged.bomRules).toHaveLength(10);
    expect(merged.bomRules[8]).toMatchObject({ id: "commissioning", enabled: true });
    expect(merged.bomRules[9]?.id).toBe("cleanup");
    expect(merged.designRules.find((r) => r.id === "chair-clearance")?.enabled).toBe(false);
    expect(() => mergePacks(AV_CORE, { ...user, extends: "other-pack" })).toThrow("extends other-pack");
  });
});
