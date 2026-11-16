---
name: reading-a-picture-with-code
description: How to turn a picture of a floor plan into walls, openings, rooms and furniture by measuring it with run_code
whenToUse: before drawing anything from an attached picture of a plan (a screenshot, a scan, a sketch, an illustration), especially one with furniture or no dimensions
---

# Reading a picture with code

A picture of a plan is copied, not paraphrased. What separates a copy from a guess is measurement:
read by eye, a plan comes out in round numbers, flipped, with symbols misread; measured with code,
walls land on their ink. So measure in `run_code`, keep what you find in variables (they survive
between calls), and act in loops. This page is a method, not a recipe: plans are drawn in many
styles, and the first job is to find out which one you have.

`import_plan` is still the tool for a clean line drawing with dimension text. Use this when the
picture has furniture, no dimensions, or `import_plan` reads it badly.

## 1. Find out how this picture is drawn

1. `image(id)` gives `{ width, height, gray }` (0 black, 255 white, row by row). Print the size and a
   histogram of grey levels: it tells you how dark the ink is and whether there is a background tone,
   scan noise or colour fill to allow for.
2. `show(crop(img))` the whole picture once, then look at a few enlarged crops. Before measuring
   anything, say in notes how walls, doors, windows and furniture are drawn *in this picture*. Common
   styles, none of them universal:
   - walls as solid dark bands, as two parallel thin lines, as hatched or filled strips, or as single
     lines in a sketch;
   - doors as a gap with a quarter-circle arc, a gap with a straight leaf, or just a gap;
   - windows as thin parallel lines inside the wall, a lighter strip, or a break with a tick;
   - furniture as outlines, filled shapes, or symbols.
3. Choose thresholds from what you printed, not from habit, and check them: print a few rows and
   columns across known walls and confirm your rule picks them out and nothing else.

## 2. Measure

- **Walls.** Find them the way this picture draws them: runs of dark pixels a wall's thickness wide
  for solid walls, pairs of parallel lines a constant distance apart for double-line walls, long
  straight strokes for a sketch. Merge neighbouring rows into segments and print each with its centre
  line and ends. Check the set by drawing it back (section 5) before going on.
- **Sample across a line before naming it.** Print the grey values across it: the profile tells a
  wall from a window from a glass partition from a dimension line.
- **Openings** are interruptions in a wall. Decide from what is drawn at each gap: a door (its hinge
  side is where the leaf or arc starts), a double door (two leaves), a window, or a plain opening. A
  gap with nothing drawn in it is an opening, not a missing piece of wall. A break is never modelled
  as two walls with space between them: the wall runs through, and the break is an `add_opening`.
- **Furniture and fittings** are read from gridded crops, never from the whole picture:
  `crop(img, { x, y, w, h })` enlarges a region under a grid labelled in the picture's own pixels.
  Work through the picture region by region and note each piece's centre, size and facing.
- **Labels** name rooms and areas; note where each sits. An open area with a label and no walls round
  it is still a named area.

## 3. Count before you build

Write the count into notes as one line:
`INVENTORY walls=N doors=N windows=N passages=N rooms=N items=N`. The first change to the project is
refused until it is there, and before the run can end what you built is compared with it, kind by
kind. Count what is drawn, one per piece: every door leaf, every window, every chair, table, cabinet
and plant. A count that leaves things out is the most common way a copy comes up short.

## 4. Scale, coordinates, conversion

**Scale.** A picture with dimension text is scaled from it. One without is scaled from things whose
real size is known, and the answer is an assumption: say it and what it was based on. Measure several
different kinds of thing in pixels -- door leaves, desks, chairs, beds, a counter's depth -- and pass
them all to `scaleFrom`:

```js
var s = scaleFrom([{ kind: "door", px: 46 }, { kind: "door", px: 44 }, { kind: "desk", px: 71 },
  { kind: "chair", px: 25 }, { kind: "counter-depth", px: 31 }]);
// { mmPerPx, low, high, agree, outliers, note }
```

One object read at one guessed size is how a copy ends up a third too big. Look again at any outlier
before trusting the answer; ask the person when nothing settles it and it matters.

**Convert once.** The picture's y runs down; the plan's runs up (millimetres, north is +y). Write the
conversion once and use it for everything:

```js
var MM = /* mm per pixel, from the scale above */ 20;
var ox = /* picture x of the plan's west edge */ 0, oy = /* picture y of its south edge */ 0;
var X = (px) => Math.round((px - ox) * MM);
var Y = (py) => Math.round((oy - py) * MM);
var L = (pixels) => Math.round(pixels * MM);
```

- **Along a wall:** `add_opening` takes `position`, the fraction from the wall's start: project the
  opening's centre onto the wall, `((p - start) . (end - start)) / |end - start|^2`.
- **Facing:** rotation 0 faces south (the back is north), rotation turns counter-clockwise, 0 to 360.
  Facing picture point `(tx, ty)` from `(px, py)`: `((Math.atan2(tx - px, ty - py) * 180 / Math.PI) + 360) % 360`.
- **Swing:** `swingDirection` is the side the leaf opens to, looking from the wall's start to its end.

## 5. Build, then check against the picture

1. Outside walls as one closed `create_walls`, then the inside walls, one wall per straight run of
   ink, openings included; keep the returned ids.
2. Openings in those walls, where the picture has them, including the way in.
3. Rooms: enclosed spaces, and named open areas as polygons (their open sides are expected).
4. Furniture in one loop of `tools.call("place_item", ...)` with `snap: false`, one call per piece
   drawn. Recipes when nothing in the catalog fits: `table`, `chair`, `sofa`, `bed`, `box`,
   `cylinder`.

Check every result in the loop: a failed call says why, and ignoring it builds half a room.

Then draw what you built back over the picture and look:

```js
var s = project();
var px = (x) => x / MM + ox, py = (y) => oy - y / MM;
var marks = s.walls.map((w) => ({ line: [px(w.start.x), py(w.start.y), px(w.end.x), py(w.end.y)], colour: "red", width: 3 }));
// items as rect or circle marks, openings as green lines across their gaps
show(draw(img, marks), "what I built, over the picture");
```

Everything should sit on its ink. Fix what does not, `validate`, and say what you assumed -- the scale
above all -- in your answer.
