// Rules pack schema (spec 07 sections 1, 3, 4): BOM rules, design rules and room recipes as data.
import { RoomPurpose } from "@fpv/ir";
import { z } from "zod";
import { Category, ProductSlug } from "../schema.js";
import { checkSyntax, ExprError } from "./expr.js";

const Expr = z.string().min(1);
const Unit = z.enum(["each", "m", "set", "hour"]);

export const DependencyRule = z.object({
  kind: z.literal("dependency"),
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  /** "item": once per triggering item; "room": once per room that has any triggering item. */
  per: z.enum(["item", "room"]).default("item"),
  when: z.object({ category: Category, where: Expr.nullable().default(null) }),
  add: z.object({
    productId: ProductSlug.nullable().default(null),
    category: Category.nullable().default(null),
    constraint: Expr.nullable().default(null),
    preferSameMake: z.boolean().default(false),
    description: z.string().nullable().default(null),
  }),
  quantity: Expr,
  unit: Unit.exclude(["hour"]),
  note: z.string().nullable().default(null),
});

export const DistanceRule = z.object({
  kind: z.literal("distance"),
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  when: z.object({
    fromCategory: Category,
    /** One category, or several of which the nearest item is used. */
    toCategory: z.union([Category, z.array(Category).min(1)]),
    sameRoom: z.boolean().default(true),
  }),
  add: z.object({
    category: z.literal("cable"),
    constraint: Expr,
    /** "{m}" is replaced by the length in metres. */
    description: z.string().nullable().default(null),
  }),
  length: Expr,
  /** true: one cable for every pair; false: one cable from each source to its nearest target. */
  perPair: z.boolean().default(false),
});

export const ScopeRule = z.object({
  kind: z.literal("scope"),
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  scope: z.enum(["room", "level", "project"]),
  when: Expr.nullable().default(null),
  add: z.object({
    productId: ProductSlug.nullable().default(null),
    category: Category.nullable().default(null),
    constraint: Expr.nullable().default(null),
    description: z.string().nullable().default(null),
  }),
  quantity: Expr,
  unit: Unit,
  labour: z.boolean().default(false),
});

export const BomRule = z.discriminatedUnion("kind", [DependencyRule, DistanceRule, ScopeRule]);

export const DesignRule = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  applies: Expr,
  check: Expr,
  message: z.string().min(1),
  hint: z.string().nullable().default(null),
  severity: z.enum(["warning", "error"]).default("warning"),
});

const RecipeStep = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("table"),
    shape: z.enum(["rect", "round", "boat"]),
    seatsExpr: Expr,
    clearanceMm: z.number(),
  }),
  z.object({ op: z.literal("chairs"), around: z.literal("table"), pitchMm: z.number() }),
  z.object({
    op: z.literal("display"),
    wall: z.enum(["auto", "north", "south", "east", "west"]),
    diagonalExpr: Expr,
    centreHeightMm: z.number(),
    countExpr: Expr,
  }),
  z.object({ op: z.literal("video-bar"), under: z.literal("display") }),
  z.object({
    op: z.literal("ceiling-array"),
    category: z.enum(["ceiling-mic", "ceiling-speaker"]),
    perAreaM2: z.number().positive(),
    minCount: z.number().int().min(0),
  }),
  z.object({
    op: z.literal("by-door"),
    category: z.enum(["scheduler", "touch-panel"]),
    heightMm: z.number(),
    side: z.enum(["outside", "inside"]),
  }),
  z.object({
    op: z.literal("arrange"),
    pattern: z.string(),
    category: Category,
    countExpr: Expr,
    spacingMm: z.number(),
    /** Chairs placed behind each arranged table, facing the display wall. */
    seatsEach: z.number().int().min(0).default(0),
  }),
  z.object({ op: z.literal("whiteboard"), wall: z.enum(["auto", "opposite-display"]) }),
]);

export const RoomRecipe = z.object({
  id: z.string().min(1),
  purpose: RoomPurpose,
  capacityRange: z.tuple([z.number().int(), z.number().int()]),
  steps: z.array(RecipeStep),
  productPreferences: z.array(
    z.object({ category: Category, constraint: Expr, preferMake: z.array(z.string()) }),
  ),
});

export const FactValue = z.union([z.number(), z.array(z.number())]);

export const RulesPack = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string(),
  /** Pack id this one overlays; rules with the same id replace the base rule. */
  extends: z.string().nullable().default(null),
  facts: z.record(FactValue).default({}),
  bomRules: z.array(BomRule).default([]),
  designRules: z.array(DesignRule).default([]),
  recipes: z.array(RoomRecipe).default([]),
});

export type DependencyRule = z.infer<typeof DependencyRule>;
export type DistanceRule = z.infer<typeof DistanceRule>;
export type ScopeRule = z.infer<typeof ScopeRule>;
export type BomRule = z.infer<typeof BomRule>;
export type DesignRule = z.infer<typeof DesignRule>;
export type RoomRecipe = z.infer<typeof RoomRecipe>;
export type RulesPack = z.infer<typeof RulesPack>;
export type RulesPackInput = z.input<typeof RulesPack>;

export interface PackProblem {
  ruleId: string | null;
  message: string;
}

/** Shape, then every expression's syntax, then duplicate ids within the pack. */
export function validatePack(input: unknown): { pack: RulesPack | null; problems: PackProblem[] } {
  const parsed = RulesPack.safeParse(input);
  if (!parsed.success)
    return {
      pack: null,
      problems: parsed.error.issues.map((i) => ({
        ruleId: null,
        message: `${i.path.join(".") || "pack"}: ${i.message}`,
      })),
    };
  const pack = parsed.data;
  const problems: PackProblem[] = [];
  const syntax = (ruleId: string, field: string, src: string | null) => {
    if (src === null) return;
    try {
      checkSyntax(src);
    } catch (e) {
      problems.push({ ruleId, message: `${field}: ${e instanceof ExprError ? e.message : String(e)}` });
    }
  };
  const seen = new Set<string>();
  const dup = (id: string, list: string) => {
    const key = `${list}:${id}`;
    if (seen.has(key)) problems.push({ ruleId: id, message: `duplicate ${list} id ${id}` });
    seen.add(key);
  };
  for (const r of pack.bomRules) {
    dup(r.id, "bom rule");
    if (r.kind === "dependency") {
      syntax(r.id, "when.where", r.when.where);
      syntax(r.id, "add.constraint", r.add.constraint);
      syntax(r.id, "quantity", r.quantity);
      if (!r.add.productId && !r.add.category)
        problems.push({ ruleId: r.id, message: "add needs a productId or a category" });
    } else if (r.kind === "distance") {
      syntax(r.id, "add.constraint", r.add.constraint);
      syntax(r.id, "length", r.length);
    } else {
      syntax(r.id, "when", r.when);
      syntax(r.id, "add.constraint", r.add.constraint);
      syntax(r.id, "quantity", r.quantity);
      if (!r.add.productId && !r.add.category && !r.add.description)
        problems.push({ ruleId: r.id, message: "add needs a productId, a category or a description" });
    }
  }
  for (const r of pack.designRules) {
    dup(r.id, "design rule");
    syntax(r.id, "applies", r.applies);
    syntax(r.id, "check", r.check);
  }
  for (const r of pack.recipes) {
    dup(r.id, "recipe");
    if (r.capacityRange[0] > r.capacityRange[1])
      problems.push({ ruleId: r.id, message: "capacityRange is [min, max] with min <= max" });
    r.steps.forEach((s, i) => {
      if (s.op === "table") syntax(r.id, `steps.${i}.seatsExpr`, s.seatsExpr);
      if (s.op === "display") {
        syntax(r.id, `steps.${i}.diagonalExpr`, s.diagonalExpr);
        syntax(r.id, `steps.${i}.countExpr`, s.countExpr);
      }
      if (s.op === "arrange") syntax(r.id, `steps.${i}.countExpr`, s.countExpr);
    });
    r.productPreferences.forEach((pref, i) =>
      syntax(r.id, `productPreferences.${i}.constraint`, pref.constraint),
    );
  }
  return { pack, problems };
}

/**
 * Overlay `top` on `base` (spec 07 section 1): facts merge, rules and recipes with the same id replace
 * the base entry in place (so a user can set enabled: false), new ids append in order.
 */
export function mergePacks(base: RulesPack, top: RulesPack): RulesPack {
  if (top.extends !== null && top.extends !== base.id)
    throw new Error(`pack ${top.id} extends ${top.extends}, not ${base.id}`);
  const byId = <T extends { id: string }>(a: readonly T[], b: readonly T[]): T[] => {
    const out = [...a];
    for (const x of b) {
      const i = out.findIndex((y) => y.id === x.id);
      if (i >= 0) out[i] = x;
      else out.push(x);
    }
    return out;
  };
  return {
    id: top.id,
    version: top.version,
    name: top.name,
    extends: base.id,
    facts: { ...base.facts, ...top.facts },
    bomRules: byId(base.bomRules, top.bomRules),
    designRules: byId(base.designRules, top.designRules),
    recipes: byId(base.recipes, top.recipes),
  };
}
