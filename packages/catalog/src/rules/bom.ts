// The bill of materials (spec 07 section 5, ADR-009): a pure function of the project, its snapshots, an
// optional live catalog and a rules pack. Every line names what caused it. No model is in this loop.
import type { Level, Project, Room } from "@fpv/ir";
import { z } from "zod";
import { evalCondition, evalNumber, Handle, type Value } from "./expr.js";
import {
  type BomCatalog,
  type ItemFacts,
  makeScope,
  type ProductInfo,
  ProjectFacts,
  productInfo,
  recipeDescription,
  type ScopeInput,
} from "./facts.js";
import type { DependencyRule, DistanceRule, RulesPack, ScopeRule } from "./schema.js";

export const BomUnit = z.enum(["each", "m", "set", "hour"]);
export const BomStatus = z.enum(["verified", "unverified", "placeholder", "labour"]);

export const BomLine = z.object({
  scope: z.object({ levelId: z.string().nullable(), roomId: z.string().nullable() }),
  productId: z.string().nullable(),
  recipe: z.string().nullable(),
  description: z.string(),
  category: z.string(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  quantity: z.number(),
  unit: BomUnit,
  unitPrice: z
    .object({
      amount: z.number(),
      currency: z.string(),
      type: z.enum(["list", "street", "quote"]),
      sourceUrl: z.string().nullable(),
      capturedAt: z.string().nullable(),
      expiresAt: z.string().nullable(),
    })
    .nullable(),
  total: z.number().nullable(),
  reason: z.object({
    kind: z.enum(["item", "opening", "rule"]),
    ids: z.array(z.string()),
    ruleId: z.string().nullable(),
    expression: z.string().nullable(),
    evaluated: z.string().nullable(),
  }),
  status: BomStatus,
});

export const Bom = z.object({
  generatedAt: z.string(),
  currency: z.string(),
  rulesPack: z.object({ id: z.string(), version: z.string() }),
  catalogSnapshotAt: z.string(),
  lines: z.array(BomLine),
  byRoom: z.array(
    z.object({ roomId: z.string(), name: z.string().nullable(), total: z.number(), lines: z.number() }),
  ),
  totals: z.object({
    verified: z.number(),
    unverified: z.number(),
    placeholder: z.number(),
    labour: z.number(),
    all: z.number(),
    excludedCurrencies: z.array(z.string()),
  }),
});

export type BomLine = z.infer<typeof BomLine>;
export type Bom = z.infer<typeof Bom>;
export type BomScope = { kind: "project" } | { kind: "level"; id: string } | { kind: "room"; id: string };

export interface BomOptions {
  now: string;
  catalog?: BomCatalog | null;
  scope?: BomScope;
  /** Keep the expression and its evaluated value on rule lines (ADR-009 D5). */
  explain?: boolean;
}

/** "project", "level:<id>" or "room:<id>"; null for anything else. */
export function parseBomScope(text: string): BomScope | null {
  if (text === "project") return { kind: "project" };
  const m = /^(level|room):(.+)$/.exec(text);
  return m ? { kind: m[1] as "level" | "room", id: m[2] as string } : null;
}

interface Where {
  level: Level | null;
  room: Room | null;
}

function scopeOfItem(f: ItemFacts): Where {
  return { level: f.level, room: f.room };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;

function metres(mm: number): string {
  return String(round2(mm / 1000));
}

class Builder {
  private readonly lines = new Map<string, BomLine>();
  readonly usedSnapshots: string[] = [];

  constructor(
    private readonly explain: boolean,
    private readonly currency: string,
  ) {}

  add(where: Where, line: Omit<BomLine, "scope" | "total">): void {
    const scope = { levelId: where.room?.levelId ?? where.level?.id ?? null, roomId: where.room?.id ?? null };
    const reason = this.explain ? line.reason : { ...line.reason, expression: null, evaluated: null };
    const identity = line.productId ?? line.recipe ?? `desc:${line.description}`;
    const key = [
      scope.levelId,
      scope.roomId,
      reason.kind,
      reason.ruleId,
      identity,
      line.unit,
      line.status,
    ].join("|");
    const prev = this.lines.get(key);
    if (prev) {
      prev.quantity = round3(prev.quantity + line.quantity);
      prev.reason.ids = [...new Set([...prev.reason.ids, ...reason.ids])].sort();
      if (reason.evaluated && prev.reason.evaluated !== reason.evaluated)
        prev.reason.evaluated = [
          ...new Set([...(prev.reason.evaluated ?? "").split("; ").filter(Boolean), reason.evaluated]),
        ].join("; ");
      return;
    }
    this.lines.set(key, {
      ...line,
      scope,
      quantity: round3(line.quantity),
      total: null,
      reason: { ...reason, ids: [...reason.ids].sort() },
    });
  }

  fromProduct(
    p: ProductInfo,
  ): Pick<
    BomLine,
    "productId" | "recipe" | "description" | "category" | "make" | "model" | "unitPrice" | "status"
  > {
    if (p.snapshotAt) this.usedSnapshots.push(p.snapshotAt);
    return {
      productId: p.id,
      recipe: null,
      description: p.name,
      category: p.category,
      make: p.make,
      model: p.model,
      unitPrice: p.price ? { ...p.price, currency: p.price.currency ?? this.currency } : null,
      status: p.status === "verified" || p.status === "manual" ? "verified" : "unverified",
    };
  }

  all(): BomLine[] {
    return [...this.lines.values()];
  }
}

function placeholder(
  category: string,
  description: string,
): Pick<
  BomLine,
  "productId" | "recipe" | "description" | "category" | "make" | "model" | "unitPrice" | "status"
> {
  return {
    productId: null,
    recipe: null,
    description,
    category,
    make: null,
    model: null,
    unitPrice: null,
    status: "placeholder",
  };
}

export function getBom(project: Project, pack: RulesPack, options: BomOptions): Bom {
  const facts = new ProjectFacts(project, options.catalog ?? null);
  const currency = project.meta.currency;
  const b = new Builder(options.explain ?? false, currency);
  const base = (where: Where, items: readonly ItemFacts[]): ScopeInput => ({
    facts,
    items,
    room: where.room,
    level: where.level,
    packFacts: pack.facts,
  });
  const itemsFor = (where: Where): readonly ItemFacts[] =>
    where.room ? facts.inRoom(where.room) : where.level ? facts.unroomed(where.level) : facts.items;

  // 1. item lines: one per placed item, grouped by product within its scope
  for (const f of facts.items) {
    const where = scopeOfItem(f);
    const reason = {
      kind: "item" as const,
      ids: [f.item.id],
      ruleId: null,
      expression: null,
      evaluated: null,
    };
    if (f.product) b.add(where, { ...b.fromProduct(f.product), quantity: 1, unit: "each", reason });
    else if (f.recipe)
      b.add(where, {
        ...placeholder(f.category, recipeDescription(f.item)),
        recipe: f.recipe,
        quantity: 1,
        unit: "each",
        reason,
      });
    else {
      const id = f.item.ref.kind === "product" ? f.item.ref.productId : f.item.id;
      b.add(where, { ...placeholder("other", `Unknown product ${id}`), quantity: 1, unit: "each", reason });
    }
  }
  // openings with a product (doors and windows) belong to their level
  for (const o of [...project.openings].sort((x, y) => x.id.localeCompare(y.id))) {
    if (!o.productId) continue;
    const where = { level: facts.levelOf(o.levelId), room: null };
    const reason = { kind: "opening" as const, ids: [o.id], ruleId: null, expression: null, evaluated: null };
    const p = facts.product(o.productId);
    b.add(where, {
      ...(p ? b.fromProduct(p) : placeholder("other", `Unknown product ${o.productId}`)),
      quantity: 1,
      unit: "each",
      reason,
    });
  }

  /** ADR-009 D4: a matching product in the project, else a verified catalog product, else nothing. */
  const resolve = (
    category: string,
    constraint: string | null,
    scope: ScopeInput,
    preferMake: string | null,
  ): { product: ProductInfo | null; error: string | null } => {
    const test = (p: ProductInfo): string | true | false => {
      const r = evalCondition(constraint ?? "true", makeScope({ ...scope, candidate: p }));
      return r.ok ? r.value : r.error;
    };
    let firstError: string | null = null;
    const pick = (list: ProductInfo[]): ProductInfo | null => {
      const ok = list.filter((p) => {
        const t = test(p);
        if (typeof t === "string") firstError ??= t;
        return t === true;
      });
      ok.sort((x, y) => {
        const mk = (p: ProductInfo) =>
          preferMake && p.make?.toLowerCase() === preferMake.toLowerCase() ? 0 : 1;
        const len = (p: ProductInfo) => (typeof p.specs.lengthMm === "number" ? p.specs.lengthMm : 0);
        const price = (p: ProductInfo) => p.price?.amount ?? Number.POSITIVE_INFINITY;
        return mk(x) - mk(y) || len(x) - len(y) || price(x) - price(y) || x.id.localeCompare(y.id);
      });
      return ok[0] ?? null;
    };
    const inProject = [...facts.products.values()].filter(
      (p) => p.category === category && p.status !== "rejected",
    );
    const fromProject = pick(inProject);
    if (fromProject) return { product: fromProject, error: null };
    const live = (options.catalog?.byCategory?.(category) ?? [])
      .map(productInfo)
      .filter((p): p is ProductInfo => p !== null && (p.status === "verified" || p.status === "manual"));
    return { product: pick(live), error: firstError };
  };

  const ruleLine = (
    where: Where,
    rule: { id: string },
    ids: string[],
    quantity: number,
    unit: BomLine["unit"],
    expression: string,
    evaluated: string,
    body: ReturnType<typeof placeholder>,
  ) =>
    b.add(where, {
      ...body,
      quantity,
      unit,
      reason: { kind: "rule", ids, ruleId: rule.id, expression, evaluated },
    });

  const failed = (
    where: Where,
    rule: { id: string },
    ids: string[],
    unit: BomLine["unit"],
    category: string,
    expression: string,
    error: string,
  ) => ruleLine(where, rule, ids, 1, unit, expression, error, placeholder(category, `${rule.id}: ${error}`));

  // 2. dependency rules
  const dependency = (rule: DependencyRule) => {
    const triggers = facts.items.filter((f) => f.category === rule.when.category);
    const groups: { where: Where; items: ItemFacts[] }[] = [];
    if (rule.per === "item") for (const f of triggers) groups.push({ where: scopeOfItem(f), items: [f] });
    else {
      const byKey = new Map<string, { where: Where; items: ItemFacts[] }>();
      for (const f of triggers) {
        const k = f.room?.id ?? `level:${f.level.id}`;
        const g = byKey.get(k) ?? { where: scopeOfItem(f), items: [] };
        g.items.push(f);
        byKey.set(k, g);
      }
      groups.push(...byKey.values());
    }
    const category = rule.add.category ?? "other";
    for (const g of groups) {
      const trigger = g.items[0] as ItemFacts;
      const scope: ScopeInput = { ...base(g.where, itemsFor(g.where)), trigger };
      const matching = rule.when.where
        ? g.items.filter((f) => {
            const r = evalCondition(rule.when.where as string, makeScope({ ...scope, trigger: f }));
            if (!r.ok)
              failed(g.where, rule, [f.item.id], rule.unit, category, rule.when.where as string, r.error);
            return r.ok && r.value;
          })
        : g.items;
      if (matching.length === 0) continue;
      const ids = matching.map((f) => f.item.id);
      const q = evalNumber(rule.quantity, makeScope({ ...scope, trigger: matching[0] as ItemFacts }));
      if (!q.ok) {
        failed(g.where, rule, ids, rule.unit, category, rule.quantity, q.error);
        continue;
      }
      if (q.value <= 0) continue;
      const evaluated = `${rule.quantity} = ${round3(q.value)}`;
      const t = matching[0] as ItemFacts;
      if (rule.add.productId) {
        const p = facts.product(rule.add.productId);
        ruleLine(
          g.where,
          rule,
          ids,
          q.value,
          rule.unit,
          rule.quantity,
          evaluated,
          p ? b.fromProduct(p) : placeholder(category, `Unknown product ${rule.add.productId}`),
        );
        continue;
      }
      const r = resolve(
        category,
        rule.add.constraint,
        { ...scope, trigger: t },
        rule.add.preferSameMake ? (t.product?.make ?? null) : null,
      );
      const desc = rule.add.description ?? `${category} where ${rule.add.constraint ?? "any"}`;
      ruleLine(
        g.where,
        rule,
        ids,
        q.value,
        rule.unit,
        rule.quantity,
        r.product
          ? evaluated
          : `${evaluated}; no product matches ${rule.add.constraint ?? category}${r.error ? ` (${r.error})` : ""}`,
        r.product ? b.fromProduct(r.product) : placeholder(category, desc),
      );
    }
  };

  // 3. distance rules
  const distance = (rule: DistanceRule) => {
    const targets = Array.isArray(rule.when.toCategory) ? rule.when.toCategory : [rule.when.toCategory];
    for (const from of facts.items.filter((f) => f.category === rule.when.fromCategory)) {
      const pool = facts.items.filter(
        (f) =>
          f !== from &&
          targets.includes(f.category as (typeof targets)[number]) &&
          f.level.id === from.level.id &&
          (!rule.when.sameRoom || (f.room?.id ?? null) === (from.room?.id ?? null)),
      );
      if (pool.length === 0) continue;
      const run = (f: ItemFacts) =>
        Math.abs(f.item.position.x - from.item.position.x) +
        Math.abs(f.item.position.y - from.item.position.y);
      const chosen = rule.perPair
        ? pool
        : [[...pool].sort((x, y) => run(x) - run(y) || x.item.id.localeCompare(y.item.id))[0] as ItemFacts];
      const where = scopeOfItem(from);
      for (const to of chosen) {
        const ids = [from.item.id, to.item.id];
        const locals: Record<string, Value> = { from: new Handle("item", from), to: new Handle("item", to) };
        const scope: ScopeInput = { ...base(where, itemsFor(where)), trigger: from, locals };
        const len = evalNumber(rule.length, makeScope(scope));
        if (!len.ok) {
          failed(where, rule, ids, "each", "cable", rule.length, len.error);
          continue;
        }
        const evaluated = `${rule.length} = ${round3(len.value)}`;
        const r = resolve(
          "cable",
          rule.add.constraint,
          { ...scope, locals: { ...locals, length: len.value } },
          null,
        );
        const desc = (rule.add.description ?? "Cable {m} m").replaceAll("{m}", metres(len.value));
        ruleLine(
          where,
          rule,
          ids,
          1,
          "each",
          rule.length,
          r.product ? evaluated : `${evaluated}; no product matches ${rule.add.constraint}`,
          r.product ? b.fromProduct(r.product) : placeholder("cable", desc),
        );
      }
    }
  };

  // 4. scope rules
  const scopeRule = (rule: ScopeRule) => {
    const places: Where[] =
      rule.scope === "room"
        ? facts.rooms.map((room) => ({ room, level: facts.levelOf(room.levelId) }))
        : rule.scope === "level"
          ? facts.levels.map((level) => ({ level, room: null }))
          : [{ level: null, room: null }];
    const category = rule.add.category ?? "other";
    for (const where of places) {
      const items = rule.scope === "level" && where.level ? facts.onLevel(where.level) : itemsFor(where);
      const scope = base(where, items);
      const ids = [where.room?.id ?? where.level?.id ?? "project"];
      if (rule.when) {
        const c = evalCondition(rule.when, makeScope(scope));
        if (!c.ok) {
          failed(where, rule, ids, rule.unit, category, rule.when, c.error);
          continue;
        }
        if (!c.value) continue;
      }
      const q = evalNumber(rule.quantity, makeScope(scope));
      if (!q.ok) {
        failed(where, rule, ids, rule.unit, category, rule.quantity, q.error);
        continue;
      }
      if (q.value <= 0) continue;
      const evaluated = `${rule.quantity} = ${round3(q.value)}`;
      const desc = rule.add.description ?? category;
      if (rule.labour) {
        ruleLine(where, rule, ids, q.value, rule.unit, rule.quantity, evaluated, {
          ...placeholder(category, desc),
          status: "labour",
        });
        continue;
      }
      if (rule.add.productId) {
        const p = facts.product(rule.add.productId);
        ruleLine(
          where,
          rule,
          ids,
          q.value,
          rule.unit,
          rule.quantity,
          evaluated,
          p ? b.fromProduct(p) : placeholder(category, `Unknown product ${rule.add.productId}`),
        );
        continue;
      }
      if (rule.add.constraint) {
        const r = resolve(category, rule.add.constraint, scope, null);
        ruleLine(
          where,
          rule,
          ids,
          q.value,
          rule.unit,
          rule.quantity,
          r.product ? evaluated : `${evaluated}; no product matches ${rule.add.constraint}`,
          r.product ? b.fromProduct(r.product) : placeholder(category, desc),
        );
        continue;
      }
      ruleLine(where, rule, ids, q.value, rule.unit, rule.quantity, evaluated, placeholder(category, desc));
    }
  };

  for (const rule of pack.bomRules) {
    if (!rule.enabled) continue;
    if (rule.kind === "dependency") dependency(rule);
    else if (rule.kind === "distance") distance(rule);
    else scopeRule(rule);
  }

  // prices, filtering, ordering, totals
  const excluded = new Set<string>();
  let lines = b.all().map((l) => {
    if (!l.unitPrice) return l;
    if (l.unitPrice.currency !== currency) {
      excluded.add(l.unitPrice.currency);
      return l;
    }
    return { ...l, total: round2(l.quantity * l.unitPrice.amount) };
  });
  const scope = options.scope ?? { kind: "project" };
  if (scope.kind === "room") lines = lines.filter((l) => l.scope.roomId === scope.id);
  if (scope.kind === "level") lines = lines.filter((l) => l.scope.levelId === scope.id);

  const levelRank = new Map(facts.levels.map((l, i) => [l.id, i]));
  const roomRank = new Map(facts.rooms.map((r, i) => [r.id, i]));
  const rank = (l: BomLine): [number, number, number] =>
    l.scope.levelId === null
      ? [0, 0, 0]
      : [
          1,
          levelRank.get(l.scope.levelId) ?? 0,
          l.scope.roomId === null ? -1 : (roomRank.get(l.scope.roomId) ?? 0),
        ];
  lines.sort((x, y) => {
    const [a1, a2, a3] = rank(x);
    const [b1, b2, b3] = rank(y);
    const idx = (l: BomLine) => l.productId ?? `~${l.recipe ?? l.description}`;
    return (
      a1 - b1 ||
      a2 - b2 ||
      a3 - b3 ||
      x.category.localeCompare(y.category) ||
      idx(x).localeCompare(idx(y)) ||
      (x.reason.ruleId ?? "").localeCompare(y.reason.ruleId ?? "") ||
      x.unit.localeCompare(y.unit)
    );
  });

  const totals = {
    verified: 0,
    unverified: 0,
    placeholder: 0,
    labour: 0,
    all: 0,
    excludedCurrencies: [...excluded].sort(),
  };
  for (const l of lines) {
    if (l.total === null) continue;
    totals[l.status] = round2(totals[l.status] + l.total);
    totals.all = round2(totals.all + l.total);
  }
  const byRoom = facts.rooms
    .map((room) => {
      const mine = lines.filter((l) => l.scope.roomId === room.id);
      return {
        roomId: room.id,
        name: room.name,
        total: round2(mine.reduce((s, l) => s + (l.total ?? 0), 0)),
        lines: mine.length,
      };
    })
    .filter((r) => r.lines > 0);
  const snapshots = [...b.usedSnapshots].sort();
  return {
    generatedAt: options.now,
    currency,
    rulesPack: { id: pack.id, version: pack.version },
    catalogSnapshotAt: snapshots.at(-1) ?? project.meta.updatedAt,
    lines,
    byRoom,
    totals,
  };
}

// ---- CSV ---------------------------------------------------------------------------------------------

export const BOM_CSV_COLUMNS = [
  "level",
  "room",
  "category",
  "product_id",
  "recipe",
  "make",
  "model",
  "description",
  "quantity",
  "unit",
  "unit_price",
  "currency",
  "total",
  "status",
  "reason",
  "ids",
  "rule",
] as const;

function cell(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Deterministic CSV of a BOM: one header row, one row per line, in BOM order, LF line ends. */
export function bomToCsv(bom: Bom, project: Project): string {
  const levelName = new Map(project.levels.map((l) => [l.id, l.name]));
  const roomName = new Map(project.rooms.map((r) => [r.id, r.name ?? r.id]));
  const rows = [BOM_CSV_COLUMNS.join(",")];
  for (const l of bom.lines)
    rows.push(
      [
        l.scope.levelId ? (levelName.get(l.scope.levelId) ?? l.scope.levelId) : "",
        l.scope.roomId ? (roomName.get(l.scope.roomId) ?? l.scope.roomId) : "",
        l.category,
        l.productId,
        l.recipe,
        l.make,
        l.model,
        l.description,
        l.quantity,
        l.unit,
        l.unitPrice ? l.unitPrice.amount.toFixed(2) : null,
        l.unitPrice?.currency ?? null,
        l.total === null ? null : l.total.toFixed(2),
        l.status,
        l.reason.kind,
        l.reason.ids.join(" "),
        l.reason.ruleId,
      ]
        .map(cell)
        .join(","),
    );
  return `${rows.join("\n")}\n`;
}
