# Spec 07: Rules pack schema, expression language, room recipes, and BOM output

Status: Draft
Date: 2026-09-14
Implements: ADR-009, and the Space Designer's rules pack from ADR-006 (furnish_room)
Package: `packages/catalog` (rules, bom), `packages/agents` (recipes consumer)

## 1. Rules pack file

```ts
export const RulesPack = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string(),
  extends: z.string().nullable(),          // pack id this one overlays; rule ids override by id
  facts: z.record(z.number()),             // named constants, e.g. cableStockLengthsMm
  bomRules: z.array(BomRule),
  designRules: z.array(DesignRule),
  recipes: z.array(RoomRecipe),
});
```

Packs merge by id: user pack rules with the same id replace base rules;
new ids append. A rule may set `enabled: false` to disable a base rule.

## 2. Expression language

A small, total, side-effect-free language evaluated by our own parser.
Grammar (EBNF):

```
expr     := term (("+" | "-") term)*
term     := unary (("*" | "/") unary)*
unary    := "-" unary | atom
atom     := number | ident | ident "(" args? ")" | "(" expr ")"
args     := expr ("," expr)*
cond     := expr cmp expr | cond ("and" | "or") cond | "not" cond | "(" cond ")"
cmp      := "<" | "<=" | "==" | "!=" | ">=" | ">"
```

Numbers are decimal. Identifiers resolve against a scope of facts. Function
set, first release:

| Function | Meaning |
|---|---|
| `count(category)` | items in scope with that category |
| `countWhere(category, key, op, value)` | items with a spec matching |
| `spec(key)` | spec value of the triggering item |
| `sum(category, key)` | sum of a spec over items |
| `max(category, key)`, `min(category, key)` | |
| `room.area`, `room.perimeter`, `room.capacity`, `room.ceilingHeight` | in mm², mm, count, mm |
| `level.height` | mm |
| `distance(a, b)` | Manhattan run via the ceiling between two items: horizontal distance plus (ceiling minus mount height) for each end, mm |
| `ceil(x)`, `floor(x)`, `roundUpTo(x, step)`, `roundUpToAny(x, factName)` | the last rounds up to the nearest value in a facts list |
| `clamp(x, lo, hi)` | |
| `if(cond, a, b)` | evaluates only the branch it takes |
| `abs(x)`, `round(x)`, `sqrt(x)`, `tan(deg)` | |
| `has(list, value)` | a list fact or a comma-separated text contains the value, spaces and case ignored (VESA patterns) |
| `farthest(catA, catB)`, `nearest(catA, catB)` | horizontal distance between item centres, mm |
| `clearanceBehind(category)` | smallest free distance from the back edge of any item of the category to the room boundary or a floor item, mm |
| `doorSwingBlocked()` | floor items overlapping the square a door sweeps on the room's side (door width by door width from the wall face) |

As implemented (packages/catalog/src/rules): literals include `'text'`,
`true` and `false`; `x in ('a', 'b')` tests membership; `and` binds tighter
than `or`; both short-circuit. Identifiers: `item.<field>` for the
triggering item (`mount`, `weightKg`, `w`, `d`, `h`, `elevation`,
`centreHeight`, `connectionHeight`, `make`, `category`), `room.<field>`
(`area`, `areaM2`, `perimeter`, `capacity` falling back to the chair count,
`ceilingHeight`, `purpose`, `name`), `level.height`, `level.elevation`, the
pack's facts, and inside a constraint the candidate product's specs and
`id`, `make`, `model`, `w`, `d`, `h`, `weightKg`. The `key` argument of
`countWhere`, `sum`, `max` and `min` accepts a spec key or one of the item
fields. `distance(from, to)` uses the connection height of each end: the
ceiling for ceiling items, the centre for wall items, the top otherwise.
`max(a, b)` and `min(a, b)` with two numbers are the numeric forms.

Evaluation errors (unknown identifier, division by zero) make the rule
produce a `placeholder` line with the error text, never a crash. A design
rule that cannot be evaluated reports `design.rule-error` naming the rule.

## 3. BOM rules

```ts
export const BomRule = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dependency"), id: z.string(), enabled: z.boolean().default(true),
    when: z.object({ category: Category, where: z.string().nullable() }),        // per triggering item
    add: z.object({ productId: ProductId.nullable(), category: Category.nullable(), constraint: z.string().nullable(), preferSameMake: z.boolean() }),
    quantity: z.string(),                                                       // expression
    unit: z.enum(["each", "m", "set"]),
    note: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("distance"), id: z.string(), enabled: z.boolean().default(true),
    when: z.object({ fromCategory: Category, toCategory: Category, sameRoom: z.boolean() }),
    add: z.object({ category: z.literal("cable"), constraint: z.string() }),    // e.g. "type == 'HDMI'"
    length: z.string(),                                                          // expression in mm, e.g. "roundUpToAny(distance(from, to) + 1000, cableStockLengthsMm)"
    perPair: z.boolean(),
  }),
  z.object({
    kind: z.literal("scope"), id: z.string(), enabled: z.boolean().default(true),
    scope: z.enum(["room", "level", "project"]),
    when: z.string().nullable(),                                                 // cond over room facts
    add: z.object({ productId: ProductId.nullable(), category: Category.nullable(), constraint: z.string().nullable(), description: z.string().nullable() }),
    quantity: z.string(),
    unit: z.enum(["each", "m", "set", "hour"]),
    labour: z.boolean(),
  }),
]);
```

Item rules are implicit: every item and every opening with a product
produces one line grouped by product within the scope.

Amendments made while implementing (the zod schema in
`packages/catalog/src/rules/schema.ts` is normative):

- `facts` values are numbers or lists of numbers (stock lengths).
- Dependency rules gain `per: "item" | "room"` (default item): the amplifier
  and DSP rules fire once per room that has any triggering item. `add` gains
  `description`, used for the placeholder when nothing resolves.
- Distance rules take `toCategory` as one category or a list, of which the
  nearest item (horizontal Manhattan distance) is the target; `add` gains
  `description` with `{m}` replaced by the length in metres; the resolved
  length is available to the constraint as `length`.
- Scope rules resolve a product only when `add.productId` or
  `add.constraint` is set (use `"true"` for any product of the category);
  otherwise the line is a description with status `placeholder`, or `labour`
  when `labour` is true.
- Resolution follows ADR-009 D4: a matching product the project already
  snapshots, else a verified or manual catalog product, else a placeholder.
  Ties go to the triggering product's make when `preferSameMake`, then the
  shortest `lengthMm`, then the lowest price, then the id. Unverified catalog
  products are never picked for rule lines.

### 3.1 Core pack rules, first release (`packages/catalog/src/rules/av-core.ts`)

The pack is data in a TypeScript module rather than a JSON file so the
browser build imports it without a loader; `AV_CORE_INPUT` is plain JSON
and validates with `validatePack`.

| id | kind | summary |
|---|---|---|
| `display-mount` | dependency | each wall-mounted display adds one mount, constraint `has(vesa, spec('vesa')) and maxKg >= item.weightKg` |
| `display-hdmi` | distance | one HDMI cable from each display to the nearest video bar or table connection point, length via ceiling, rounded to stock |
| `bar-usb` | distance | one USB cable from each video bar to the table connection point |
| `speaker-amp` | dependency | ceiling speakers add one amplifier per room with `channels >= count('ceiling-speaker')` |
| `mic-dsp` | dependency | ceiling mics add one DSP per room with `inputs >= count('ceiling-mic')` |
| `network-ports` | scope (room) | one PoE switch port per networked device: `count('display') + count('video-bar') + count('touch-panel') + count('scheduler') + count('dsp')`, plus PoE ceiling mics and the one DSP that `mic-dsp` adds when the room has ceiling mics and no placed DSP |
| `scheduler` | scope (room) | when `room.purpose in ('meeting', 'boardroom', 'huddle', 'training') and room.capacity >= 4` and the room has no scheduler item, one scheduling panel by the door |
| `table-power` | scope (room) | one table power module per 4 seats: `ceil(room.capacity / 4)` |
| `commissioning` | scope (room), labour | 4 hours per room with a display, disabled by default |

### 3.2 Residential core pack (`packages/catalog/src/rules/home-core.ts`)

`HOME_CORE` overlays `AV_CORE` (`extends: "av-core"`) and the two merge into
`CORE_RULES`, which is what the host and the eval harness load. It carries no
BOM rules yet; it carries the sizes a dwelling's rooms are judged by and the
recipes that furnish them.

| id | applies | check |
|---|---|---|
| `bedroom-size` | `room.purpose == 'bedroom'` | at least 9 m² and a clear side of 2400 mm |
| `living-size` | `living` | 12 m², side 3000 mm |
| `kitchen-size` | `kitchen` | 5 m², side 1800 mm |
| `dining-size` | `dining` | 7 m², side 2400 mm |
| `bathroom-size` | `bathroom` | 3 m², side 1500 mm |
| `toilet-size` | `toilet` | 1.2 m², side 900 mm |
| `tv-centre-height` | a wall display in a `living` room | centre within 250 mm of 1100 mm |

All are warnings: a client's brief outranks a rule of thumb, and the point is
that the agent is told, not that it is stopped. The sizes are pack facts
(`bedroomMinM2`, `bedroomMinSideMm`, ...), so a user's own pack overrides them
by id without touching code. `room.minSideMm` and `room.maxSideMm` (the sides of
the room's bounding box) were added to the expression scope for these rules: a
9 m² room 1.5 m wide is not a bedroom.

Recipes: `bedroom-single` (1 seat), `bedroom` (2 to 4), `living`, `kitchen`,
`dining`, `bathroom`, `toilet`, `study`, `laundry`, and the empty `foyer`,
`balcony`, `garage` and `corridor`, which place nothing.

## 4. Design rules and room recipes

Design rules are constraints the Space Designer checks and `validate`
reports as warnings with code prefix `design.`:

```ts
export const DesignRule = z.object({
  id: z.string(), enabled: z.boolean().default(true),
  applies: z.string(),                    // cond over room facts, e.g. "room.purpose == 'meeting'"
  check: z.string(),                      // cond that must hold, e.g. "max('display','diagonalIn') * 25.4 * 6 >= room.depthMm"
  message: z.string(),
  severity: z.enum(["warning", "error"]),
});
```

Core design rules: display diagonal at least farthest viewer distance
divided by 6 for detailed content (4 for video); camera field of view covers
the table width at its distance; one ceiling mic per 20 m² for `meeting`;
one ceiling speaker per 25 m²; 900 mm clearance behind chairs; door swing
area free of items; display centre height 1400 mm for seated rooms.

As shipped, each is a rule id: `display-size-detail`, `display-size-video`
(disabled by default), `camera-fov` (twice the farthest bar-to-chair
distance times tan of half the field of view covers the table's short side
plus two chair depths), `ceiling-mic-coverage` and `ceiling-speaker-coverage`
(meeting purposes, only above 20 and 25 m², so small rooms rely on the video
bar), `chair-clearance`, `door-swing-clear`, and `display-centre-height`
(within 150 mm). "Meeting set" means `meeting`, `boardroom`, `huddle` and
`training`. Design problems carry the room as `entityId` and its item ids in
`related`; `validate` and every mutating tool result include them when the
session has a pack. `DesignRule` gains an optional `hint`, and `severity`
defaults to `warning`.

Recipes:

```ts
export const RoomRecipe = z.object({
  id: z.string(),                          // "boardroom", "huddle", "training", "open-plan-bench", "cafeteria"
  purpose: RoomPurpose,
  capacityRange: z.tuple([z.number().int(), z.number().int()]),
  steps: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("table"), shape: z.enum(["rect", "round", "boat"]), seatsExpr: z.string(), clearanceMm: z.number() }),
    z.object({ op: z.literal("chairs"), around: z.literal("table"), pitchMm: z.number() }),
    z.object({ op: z.literal("display"), wall: z.enum(["auto", "north", "south", "east", "west"]), diagonalExpr: z.string(), centreHeightMm: z.number(), countExpr: z.string() }),
    z.object({ op: z.literal("video-bar"), under: z.literal("display") }),
    z.object({ op: z.literal("ceiling-array"), category: z.enum(["ceiling-mic", "ceiling-speaker"]), perAreaM2: z.number(), minCount: z.number() }),
    z.object({ op: z.literal("by-door"), category: z.enum(["scheduler", "touch-panel"]), heightMm: z.number(), side: z.enum(["outside", "inside"]) }),
    z.object({ op: z.literal("arrange"), pattern: z.string(), category: Category, countExpr: z.string(), spacingMm: z.number() }),
    z.object({ op: z.literal("whiteboard"), wall: z.enum(["auto", "opposite-display"]) }),
    z.object({ op: z.literal("along-wall"), category: Category,
               wall: z.enum(["auto", "opposite-display", "beside-display", "north", "south", "east", "west"]),
               countExpr: z.string(), where: z.string().nullable(), shape: z.enum(["bed", "sofa", "box"]),
               sizeMm: z.object({ w: z.number(), d: z.number(), h: z.number() }), label: z.string(),
               spacingMm: z.number(), align: z.enum(["start", "centre", "end"]), clearanceMm: z.number() }),
  ])),
  productPreferences: z.array(z.object({ category: Category, constraint: z.string(), preferMake: z.array(z.string()) })),
});
```

`furnish_room` resolves a recipe by purpose and capacity, evaluates each
step into `item.place` and `item.arrange` commands inside one transaction,
picks products by constraint through `search_catalog` with make preferences,
and returns unresolved constraints for the agent or user to verify.

### 4.1 Recipes as implemented (packages/tools/src/furnish.ts)

The core pack ships `huddle` (2 to 5 seats), `boardroom` (6 to 20) and
`training` (21 to 60). A recipe is chosen by explicit id, else by purpose
with the capacity in range, else by capacity range alone, else the closest
range. A room without a capacity gets one seat per 3 m².

Layout uses a frame on the display wall: the wall is the step's `wall`, or
for `auto` the door-free wall opposite a door (`suggestedDisplayWall`).
"Along" runs from that wall into the room, "across" runs parallel to it.

- `table`: centred in the room with its long side along the depth. A
  product fits when its length plus twice `clearanceMm` fits the depth and
  its depth plus chairs plus 900 mm behind them fits the width (a round
  table fits when its diameter plus two chair depths fits both). Without a
  fitting product, a primitive table is sized from the seats and the room.
- `chairs`: `pitchMm` apart along both long sides first, then the far end,
  then the display end with a warning; round tables get chairs evenly
  around them. Chairs face the table.
- `arrange` with pattern `rows` (the only pattern recipes support so far):
  tables with their length across the room, rows starting 2.5 m from the
  display wall, 600 mm between tables, `spacingMm` between a row's chairs
  and the next row, rows added while 900 mm stays behind the last chairs;
  `seatsEach` (new field, default 0) chairs behind each table face the
  display.
- `display`: centred on the table (or the room), its back on the wall,
  centre at `centreHeightMm`, wall-mounted to that wall. `diagonalExpr` sees
  `seatDistanceMm`, the farthest seat from the display wall centre; without a
  product the primitive display takes the next standard size.
- `video-bar`: under the first display, 50 mm below it, or above it when
  that would put it lower than 500 mm.
- `ceiling-array`: `max(minCount, ceil(area / perAreaM2))` items at the
  ceiling; microphones in a line over a rectangular table, everything else
  in an even grid over the room.
- `by-door`: on the room side (or outside) of the wall of the first door,
  150 mm past the latch edge, else past the hinge edge, avoiding other
  openings; centre at `heightMm`.
- `whiteboard`: centred on the wall opposite the display at 900 mm, skipped
  when an opening is in the way.

- `along-wall` (phase 3, for homes): items with their backs to a wall, facing
  into the room. The wall is `auto` (the display wall, which `suggestedDisplayWall`
  puts opposite the door), `opposite-display`, `beside-display` (the perpendicular
  wall with the longest free run) or a compass word. Each wall keeps two cursors:
  `align: "start"` fills from one end, `"end"` from the other, `"centre"` takes the
  middle of an untouched wall, so a bathroom's shower, basin and toilet stand in a
  row rather than in one spot. `where` is an extra condition on the product, which
  is how three `sanitary` steps choose three different fixtures. `shape` and
  `sizeMm` give the recipe placed when the catalog has nothing that fits, and
  `clearanceMm` the floor the item needs in front of it; too little of either is a
  warning, never a silent placement.

Product choice: every candidate of the category that is not rejected,
fits, and satisfies the recipe's `productPreferences` constraints for that
category (all of them, joined with `and`). Constraints see the candidate's
specs and `id`, `make`, `model`, `w`, `d`, `h`, `weightKg` first, then
`neededSeats`, `neededDiagonalIn` and `seatDistanceMm`, then `room.*` and the
pack facts. Candidates are ordered by preferred make, then verified or manual
before unverified, then the smallest fitting value of the category's key
(`seats`, `diagonalIn`, `maxRoomDepthMm`), then price, then id. Every item
the recipe places carries the tag `recipe:<id>`.

## 5. BOM output

```ts
export const BomLine = z.object({
  scope: z.object({ levelId: LevelId.nullable(), roomId: RoomId.nullable() }),
  productId: ProductId.nullable(),
  recipe: z.string().nullable(),
  description: z.string(),
  category: Category,
  make: z.string().nullable(), model: z.string().nullable(),
  quantity: z.number(),
  unit: z.enum(["each", "m", "set", "hour"]),
  unitPrice: Price.nullable(),
  total: z.number().nullable(),
  reason: z.object({ kind: z.enum(["item", "opening", "rule"]), ids: z.array(z.string()), ruleId: z.string().nullable(), expression: z.string().nullable(), evaluated: z.string().nullable() }),
  status: z.enum(["verified", "unverified", "placeholder", "labour"]),
});

export const Bom = z.object({
  generatedAt: Timestamp,
  currency: z.string().length(3),
  rulesPack: z.object({ id: z.string(), version: z.string() }),
  catalogSnapshotAt: Timestamp,
  lines: z.array(BomLine),
  byRoom: z.array(z.object({ roomId: RoomId, name: z.string().nullable(), total: z.number(), lines: z.number() })),
  totals: z.object({ verified: z.number(), unverified: z.number(), placeholder: z.number(), labour: z.number(), all: z.number(), excludedCurrencies: z.array(z.string()) }),
});
```

Determinism: lines sorted by scope (project, level, room), then category,
then product id. Two runs on the same inputs differ only in `generatedAt`.

As implemented: `unitPrice` is `{ amount, currency, type, sourceUrl,
capturedAt, expiresAt }` with the three last fields nullable, because a
catalog record may carry a bare price. Lines with the same scope, reason
kind, rule, product (or recipe or description), unit and status merge, their
ids unioned. Openings with a product are level lines; items outside any room
are level lines. `total` is null when the price is in another currency, and
that currency is listed in `totals.excludedCurrencies`. `catalogSnapshotAt`
is the newest snapshot a line used, or the project's `updatedAt`. `explain:
false` nulls `reason.expression` and `reason.evaluated`. CSV columns, one row
per line in BOM order with LF line ends: `level, room, category, product_id,
recipe, make, model, description, quantity, unit, unit_price, currency,
total, status, reason, ids, rule`.

The golden fixture is `tools/fixtures/boardroom.fpviz` (built by
`tools/build-boardroom-fixture.ts` through the tool registry) with its
fixture infrastructure library `catalog.json` and the golden `bom.csv`.

## 6. Tests

- Expression parser: precedence, unary minus, functions, unknown identifier
  error, division by zero to placeholder.
- Each core rule: a fixture room where the rule fires with a known quantity,
  and one where it does not.
- Distance rule: a display at 1400 mm on a 2700 mm ceiling and a bar 4000 mm
  away yields 4000 + 1300 + 1300 + 1000 slack, rounded up to the next stock
  length.
- BOM determinism: golden CSV for the fixture project.
- Recipes: `boardroom` for capacity 10 in an 8000 by 5000 room produces one
  table, ten chairs, one display, one bar, two ceiling mics, two speakers,
  one scheduler, and no validation errors.
