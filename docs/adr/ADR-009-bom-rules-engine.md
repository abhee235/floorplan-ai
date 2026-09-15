# ADR-009: Bill of materials as a deterministic rules engine with traceable lines

Status: Proposed
Date: 2026-09-14
Supersedes: section 5.7 (BOM) of 00-brainstorm.md
Related: ADR-001 (items, openings), ADR-006 (get_bom), ADR-008 (catalog), ADR-013 (exports)

## Context

The primary consumer is internal estimation and costing. Every line must be
explainable, and the invisible items (mounts, cables, connectors, DSPs,
amplifiers, network ports) are where estimates go wrong. An LLM must not be
in the loop that produces quantities.

## Decision

### D1. BOM is computed, never stored

`getBom(project, catalog, rulesPack, scope)` is a pure function in
`catalog`. It runs on demand from the IR and the catalog snapshot. Nothing in
the IR holds quantities or prices.

### D2. Line shape

```
BomLine {
  scope: { level?: id, room?: id }
  productId | recipe
  description, category
  quantity: number, unit: "each" | "m" | "set"
  unitPrice?: { amount, currency, type, capturedAt }
  total?: number
  reason: { kind: "item" | "opening" | "rule", ids: string[], ruleId?: string, note?: string }
  status: "verified" | "unverified" | "placeholder"
}
Bom { lines: BomLine[], byRoom: ..., totals: { verified, unverified, placeholder, currency }, generatedAt, rulesPackVersion }
```

### D3. Rule kinds

Rules are data in a versioned rules pack (JSON, schema in `catalog`), not
code. Four kinds cover the domain:

1. **Item rule** (built in): one line per placed item and per opening with a
   product, grouped by product within scope.
2. **Dependency rule**: `when` a product of category X with matching specs
   is present, `add` product or category Y with a quantity expression.
   Examples: a wall-mounted display needs one mount matching its VESA and
   weight; ceiling speakers need an amplifier with channels at least the
   speaker count; ceiling mics need a DSP with input channels at least the
   mic count; each networked device needs one switch port; a video bar needs
   one USB cable to the table.
3. **Distance rule**: `length` computed from the IR: a cable from item A to
   item B is the Manhattan run via the ceiling (horizontal distance plus two
   drops of ceiling height minus mount heights), rounded up to the next
   stock length from a list. Quantity expressions can reference item
   positions, room dimensions and ceiling height.
4. **Scope rule**: per room or per project, conditional on purpose or
   capacity: a meeting room gets one scheduling panel; a project gets a
   commissioning line per room with a display, marked as labour.

Quantity expressions are a small arithmetic language over named facts
(`count(category)`, `spec(item, key)`, `room.area`, `ceiling.height`,
`distance(a, b)`), parsed and evaluated by us. No JavaScript evaluation.

### D4. Resolution of category placeholders

A dependency rule may add a category rather than a product. Resolution order:
a product already in the project of that category and matching constraints;
a verified catalog product matching constraints, preferring the same make as
the triggering product; otherwise a placeholder line with status
`placeholder` and the constraint text, so the estimator sees the gap.

### D5. Traceability and audit

Every line carries the ids that caused it and the rule id. `get_bom` can
return `explain: true` to include the evaluated expression per rule line.
The BOM export includes a rules-pack version and the catalog snapshot date.

### D6. Rules pack management

- The `av-core` pack ships with the product: mounts, cables, DSP and
  amplifier sizing, network ports, scheduling panels, labour lines off by
  default. It lives as plain JSON-shaped data in
  `packages/catalog/src/rules/av-core.ts` so the browser build can import it.
- Packs are versioned; a project records which pack version produced its last
  export. A pack can be extended by the user's own file, merged by rule id
  with user rules winning.
- The LLM may propose rules from a brief or a vendor design guide; proposals
  enter the pack only after a human accepts them.

### D7. Currency

One currency per project from `meta.currency`. Products priced in another
currency are shown with their own currency and excluded from totals until a
rate is entered manually in the project. No live exchange rates.

## Alternatives considered

- **LLM composes the BOM.** Rejected: non-deterministic quantities are
  unacceptable for costing.
- **Rules as TypeScript functions.** Rejected: users and later the LLM must
  be able to read, propose and diff rules without a build.
- **Storing quantities in the IR.** Rejected: derived data drifts (ADR-001 D7).

## Consequences

- `catalog` gains an expression parser and evaluator with tests per rule
  kind and a fixture project with a known BOM.
- The Space Designer places real items and openings; it never writes BOM
  lines. Its job is to make the IR complete enough that the rules produce a
  full bill.
- Exports (ADR-013) render this structure; they add no logic.
