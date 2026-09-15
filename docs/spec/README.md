# Specification

The ADRs say what we decided; these documents say exactly what gets built,
precisely enough that tests are written before code. Schemas are zod and are
normative; prose explains intent and lists invariants. Units are integer
millimetres and degrees; plan coordinates are y up.

| File | Content | Implements | Status |
|---|---|---|---|
| [01-scene-ir.md](01-scene-ir.md) | Project, level, wall, opening, room, item, zone, annotation schemas; validation codes; normalisation; derived functions; serialisation | ADR-001, ADR-012 | Draft |
| [02-catalog-textures-assets.md](02-catalog-textures-assets.md) | Product, texture, asset manifest, library manifest; catalog store and search; verification records | ADR-008, ADR-010 | Draft |
| [03-commands.md](03-commands.md) | Every command: payload, preconditions, effect, change set; transactions and history | ADR-004 | Draft |
| [04-tools.md](04-tools.md) | The 23 tools with descriptions, arguments, results; tiers by profile; workflow prompt | ADR-005, ADR-006 | Draft |
| [05-geometry-invalidation-detection.md](05-geometry-invalidation-detection.md) | Tolerances; geometry and engine APIs; room detection; placement pipeline; arrangement patterns; invalidation table | ADR-003, ADR-014, ADR-015, ADR-016 | Draft |
| [06-plan-draft-and-bridge.md](06-plan-draft-and-bridge.md) | PlanDraft schema and commit rules; reader prompt contract; viewer bridge messages | ADR-005, ADR-011 | Draft |
| [07-rules-pack-and-bom.md](07-rules-pack-and-bom.md) | Rules pack schema; expression language; BOM rules and core pack; design rules; room recipes; BOM output | ADR-009, ADR-006 | Draft |
| [08-acceptance-criteria.md](08-acceptance-criteria.md) | Disposition of every ledger line by range; owning package and test file; phase gates; coverage report | ADR-002 | Draft |

Not yet specified, by design: the web app's UI (phase 3), the hosted
deployment (phase 4), exporter file layouts beyond ADR-013 (written with
each exporter), and the evaluation task cards (written with the first
agent run).
