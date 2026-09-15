# Spec 08: Acceptance criteria and ledger coverage

Status: Draft
Date: 2026-09-14
Implements: ADR-002 D4
Source: the edge-case ledger (about 780 lines, kept outside this repository)

## 1. Rule

Every ledger line has exactly one disposition and, unless the disposition
is `omit`, one owning package and one test whose name starts with the
ledger id. `pnpm ledger:coverage` parses the ledger for ids, scans test
names under `packages/*/test` and `apps/*/test`, reads the disposition map
below, and fails CI when an id with disposition `adopt`, `reverse`, or
`reject` has no test in the current phase or later.

Dispositions:

| Disposition | Meaning | Test asserts |
|---|---|---|
| `adopt` | our behaviour matches the ledger line | the line's `test` field, converted to millimetres and y-up |
| `reverse` | we deliberately do the opposite or a different rule | our rule, and that the behaviour the ledger line describes is not what we do |
| `reject` | the input is refused by validation or a command precondition | the error code |
| `defer:N` | adopted in phase N, tested then | nothing until phase N; listed in the report |
| `omit` | not applicable to our design | nothing; listed with the reason |

## 2. Map by range

Exceptions override ranges. Package names are from ADR-002.

### Walls (W)

| Ids | Package | Disposition | Test file |
|---|---|---|---|
| W-001..W-003, W-005, W-008, W-012 | geometry | adopt | `footprint.test.ts` |
| W-004, W-006, W-007, W-015, W-101 | ir | reject | `validate.wall.test.ts` |
| W-009, W-010, W-011 | engine | reverse (single invalidation path) | `expand.wall.test.ts` |
| W-013, W-014, W-016, W-017, W-029, W-041, W-135..W-140 | commands, ir | adopt (W-017 reject) | `wall.join.test.ts`, `wall.delete.test.ts` |
| W-030 | commands | reverse (both ends detached) | `wall.delete.test.ts` |
| W-018..W-027 | geometry | adopt | `joins.test.ts` |
| W-028 | geometry | reverse (symmetric pass) | `joins.test.ts` |
| W-031..W-035, W-037, W-038, W-040, W-042..W-047 | commands | adopt | `wall.move.test.ts`, `wall.split.test.ts`, `wall.join.test.ts`, `wall.reverse.test.ts` |
| W-036 | commands | defer:3 | `wall.flip.test.ts` |
| W-039 | commands | reverse (arc halved) | `wall.split.test.ts` |
| W-048, W-049, W-051..W-053, W-055, W-056, W-058, W-059 | geometry | adopt | `arc.test.ts` |
| W-050 | ir | reverse (zero normalised to null) | `normalize.test.ts` |
| W-054 | — | omit (legacy asymmetric tessellation) | |
| W-057 | engine | reverse (skirting radius clamped) | `skirting.test.ts` (defer:3) |
| W-060..W-066 | commands, apps/web | adopt (W-061 reverse: correct argument order) | `wall.arc.test.ts`, defer:3 for gestures |
| W-067..W-071, W-077..W-083, W-084..W-086, W-088 | commands, geometry | adopt | `wall.chain.test.ts`, `magnetism.test.ts` |
| W-072..W-076 | apps/web | defer:3 | `keyboard-entry.test.ts` |
| W-087 | commands | reverse (one path) | `wall.modify.test.ts` |
| W-089 | commands | defer:3 (`wall.createAroundRoom`) | |
| W-090, W-091 | apps/web | defer:3 | |
| W-092..W-096 | ir | adopt (W-096 reverse: explicit levelId) | `derive.wall.test.ts` |
| W-097..W-100, W-102..W-113 | engine | adopt (W-099, W-100, W-107, W-112..W-114 defer:3 skirting) | `walls.build.test.ts` |
| W-116 | — | omit (no such constructor) | |
| W-115, W-117, W-118 | engine, geometry | adopt (defer:3) | |
| W-119..W-122 | engine | adopt (W-119 reverse: rooms not rebuilt) | `expand.wall.test.ts` |
| W-123..W-128, W-130, W-131 | engine | adopt (W-124 omit) | `walls.build.test.ts` |
| W-129 | engine | reverse (rectangle fallback with warning) | `openings.build.test.ts` |
| W-132..W-134 | apps/web | adopt (defer:0 for W-134 in engine) | |
| W-141..W-154 | commands, geometry | adopt (fixtures converted) | `fixtures.walls.test.ts` |

### Openings (O)

| Ids | Package | Disposition | Test file |
|---|---|---|---|
| O-001..O-004, O-006 | catalog, ir | adopt (O-004 reverse: no bound flag) | `product.opening.test.ts` |
| O-005 | catalog | reject | `product.opening.test.ts` |
| O-007..O-013 | catalog | adopt (O-011 reverse: null is rectangle) | `library.import.test.ts` |
| O-014..O-016 | — | omit (opening geometry is explicit) | |
| O-017..O-037 | geometry | adopt for items in the placement pipeline (O-017 reverse: single containment pass; O-022, O-030 arc tangent; O-027..O-029 omit: depth is the wall thickness) | `placement.test.ts` |
| O-038..O-050 | commands | reverse (openings bound by id) | `opening.test.ts` |
| O-051..O-059 | engine | adopt (O-057 always both faces; O-058 omit) | `openings.build.test.ts` |
| O-060..O-064 | ir, engine | reverse (overlap rejected; stacking is a sort) | `validate.opening.test.ts` |
| O-065..O-068 | engine | adopt | `openings.build.test.ts` |
| O-069..O-076, O-080..O-082 | engine, assets | adopt (defer:2 for non-rectangular reveals) | `reveals.test.ts` |
| O-077, O-078 | — | omit (no mesh-derived cut-outs) | |
| O-079 | engine | reverse | `reveals.test.ts` |
| O-083 | engine | adopt | `expand.opening.test.ts` |
| O-084..O-091 | catalog, apps/web | adopt (O-088..O-090 defer:3 plan drawing) | `sash.test.ts` |
| O-092..O-099 | apps/web | defer:3 (O-095 reverse: height not width) | `plan.opening.test.ts` |
| O-100, O-101 | geometry | adopt via threshold patching (O-101 becomes a validation problem) | `detect.threshold.test.ts` |
| O-102..O-111 | engine | adopt (O-104 reverse: not all walls) | `expand.opening.test.ts` |
| O-112 | — | omit | |

### Rooms and levels (R)

| Ids | Package | Disposition | Test file |
|---|---|---|---|
| R-001, R-015, R-057 | ir, commands | reject (three-point minimum) | `validate.room.test.ts` |
| R-002, R-003, R-013, R-014, R-016..R-020 | ir | adopt (R-003 omit) | `room.model.test.ts` |
| R-004..R-010 | geometry | adopt (R-007..R-009 reverse: non-simple rejected, so area is absolute) | `area.test.ts` |
| R-011 | ir | adopt (normalised away, warning) | `normalize.test.ts` |
| R-012 | ir | reverse (pole of inaccessibility) | `derive.room.test.ts` |
| R-021..R-023, R-027..R-031 | geometry | adopt | `detect.test.ts` |
| R-024 | geometry | reverse (gap tolerance) | `detect.gap.test.ts` |
| R-025, R-040 | commands | adopt | `room.detect.test.ts` |
| R-026, R-149 | geometry | reverse (smallest) | `detect.nested.test.ts` |
| R-032..R-039, R-100, R-101 | geometry | reverse (thresholds from bound openings) | `detect.threshold.test.ts` |
| R-041..R-049 | apps/web | defer:3 (R-042 omit) | `room.draw.test.ts` |
| R-050..R-055 | geometry | adopt | `magnetism.test.ts` |
| R-056 | commands | reverse (projected) | `room.points.test.ts` |
| R-058..R-060 | commands, apps/web | adopt (defer:3) | |
| R-061..R-067, R-075..R-080, R-082..R-088 | engine | adopt (R-081 omit) | `rooms.build.test.ts` |
| R-068..R-071 | engine | reverse (ceiling from level) | `rooms.build.test.ts` |
| R-072..R-074 | engine | defer:3 (staircase items) | |
| R-089..R-100 | engine | defer:2 (ground, simplified) | `ground.test.ts` |
| R-101, R-102 | ir, commands | reverse (always one level) | `level.test.ts` |
| R-103..R-112, R-114..R-124 | commands, ir | adopt (R-113 reverse: explicit levelId; R-124 omit) | `level.test.ts` |
| R-125..R-131 | apps/web, geometry | defer:3 (R-131 adopt now as fixture) | `fixtures.rooms.test.ts` |
| R-132..R-137 | engine | adopt (R-133 reverse) | `expand.room.test.ts` |
| R-138..R-141 | commands | adopt (`wall.split` at room boundary, defer:3) | |
| R-142..R-148 | apps/web | defer:3 | |
| R-150 | ir | reject | `validate.room.test.ts` |

### Furniture (F)

| Ids | Package | Disposition | Test file |
|---|---|---|---|
| F-001..F-003, F-006, F-007, F-012, F-018..F-020 | ir | adopt | `item.model.test.ts` |
| F-004, F-005, F-009, F-010, F-011, F-107, F-116..F-118 | — | omit (no pitch or roll) | |
| F-008 | commands | adopt (defaults) | `item.place.test.ts` |
| F-013, F-014, F-015 | commands | adopt (as preconditions) | `item.resize.test.ts` |
| F-016, F-017 | ir | reverse (explicit levelId) | |
| F-021 | ir | adopt | |
| F-022..F-028 | apps/web | defer:3 (table sorting) | |
| F-029..F-052 | commands | reverse (groups replaced by parent links; F-035 cannot occur) | `item.parent.test.ts` |
| F-053..F-061 | commands | reverse (no groups; duplicate and delete cascade) | `item.duplicate.test.ts`, `item.delete.test.ts` |
| F-062..F-069 | geometry, commands | adopt (F-065 adopt across levels; F-066 adopt) | `placement.elevation.test.ts` |
| F-070 | commands | reverse (parent link) | `item.parent.test.ts` |
| F-071, F-072 | commands | adopt | `item.elevation.test.ts` |
| F-073, F-074 | — | omit (shelf boxes) | |
| F-075..F-082, F-084..F-086, F-088..F-096, F-098, F-099 | geometry, commands | adopt | `placement.test.ts`, `magnetism.test.ts` |
| F-083 | geometry | reverse | `placement.test.ts` |
| F-087 | geometry | reverse (symmetric epsilon) | |
| F-097 | geometry | reverse (footprint, not depth) | |
| F-100..F-106, F-108..F-112 | commands | adopt (F-109, F-110 omit: no tilt) | `item.resize.test.ts` |
| F-113..F-115 | commands, apps/web | adopt (defer:3 for gesture) | `item.rotate.test.ts` |
| F-119..F-129 | engine, assets | adopt (F-128 reverse: error) | `items.build.test.ts` |
| F-130..F-144 | apps/web | defer:3 (F-131, F-132 adopt in a hit-test module) | `hittest.test.ts` |
| F-145..F-153 | commands | adopt (F-147 adopt; F-148 200 mm) | `item.duplicate.test.ts`, `paste.test.ts` |
| F-154..F-163 | commands | adopt | `history.test.ts` |
| F-164..F-170 | commands | adopt | `item.align.test.ts` |
| F-171..F-176 | commands, ir | adopt (F-173 omit) | `item.order.test.ts` |
| F-177..F-187 | apps/web | defer:3 (F-186, F-187 adopt in ir) | |
| F-188..F-196 | apps/web, geometry | defer:3 (F-196 adopt in geometry) | `intersect.test.ts` |

### Persistence, catalog, sync (P, C, S)

| Ids | Package | Disposition | Test file |
|---|---|---|---|
| P-001..P-003, P-013..P-019, P-021 | — | omit (no zip container in the working format) or reverse (hash-named assets) | `file.test.ts` |
| P-004..P-012 | apps/host | adopt (P-005 reverse: rename; P-008..P-012 reverse: manifest hashes) | `save.test.ts` |
| P-020 | apps/host | reverse | `save.test.ts` |
| P-022..P-026 | ir | adopt (P-024 reverse) | `serialize.test.ts` |
| P-027..P-030 | ir | reverse (explicit fields) | `serialize.test.ts` |
| P-031..P-039 | ir | adopt (P-033, P-035 reverse: problems) | `deserialize.test.ts` |
| P-040..P-049 | ir | omit (reference migrations) except P-047 adopt as our first migration fixture pattern | |
| P-050..P-054, P-058..P-061 | ir, apps/host | adopt (P-051 reverse: refuse newer) | |
| P-055..P-057 | — | omit | |
| C-001..C-050 | catalog, assets | as listed in spec 02 section 7 | `library.test.ts`, `import.test.ts` |
| S-001..S-003 | apps/web | adopt (S-002 reverse: ground per ADR) | `viewer.test.ts` |
| S-004..S-036 | engine | adopt with reversals S-009, S-015, S-036 | `expand.test.ts` |
| S-037, S-038 | apps/web | adopt | `viewer.test.ts` |
| S-039..S-046 | assets, apps/web | adopt (S-045 reverse) | `assets.cache.test.ts` |
| S-047..S-055 | apps/web | adopt (S-048 reverse: one rule) | `viewer.visibility.test.ts` |

## 3. Phase gates

| Phase | Must pass |
|---|---|
| 0 | every `adopt`, `reverse`, `reject` id owned by ir, geometry, engine, commands, tools, and the six-wall fixture round trip |
| 1 | plus catalog, rules, bom, semantic tools on the boardroom task card with zero validation errors and a golden BOM |
| 2 | plus importers on the fixture plans with the metrics in spec 06 A4, ground, reveals |
| 3 | plus every `defer:3` id in apps/web |
| 4 | plus hosted deployment smoke tests and the evaluation table across providers |

## 4. Report format

`pnpm ledger:coverage` prints per package: covered, missing, deferred,
omitted counts, then the missing ids for the current phase. It writes
`docs/eval/ledger-coverage.json` for the release notes.
