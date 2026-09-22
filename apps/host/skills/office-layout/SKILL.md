---
name: office-layout
description: How a working office is zoned, sized and furnished, from the brief to the desks
whenToUse: before designing any workplace: an office, a studio, a clinic, a school wing, a hotel floor
---

# Office layout

What somebody who plans offices for a living knows, in the order they use it. The
numbers are the pack's and the checker's; the judgement is yours.

## 1. Read the brief for what it does not say

- **Headcount is the building.** People × 8 to 10 m² is the open office alone;
  the whole floor is people × 12 to 15 m² once meeting rooms, support and
  circulation are in. A hundred people is a 1,200 to 1,500 m² floor, not 120.
- **Every office has:** a reception or entry, toilets (one restroom of about
  12 m² per fifty people; the checker refuses a workplace for twenty or more
  without one), a pantry or cafeteria, meeting rooms, a store, a comms or
  server room if it is an IT office. Add them when the brief forgot them and say
  you did.
- **Meeting seats:** about one meeting seat for every three to four staff,
  spread across sizes: many 4-seat huddles, several 6 to 8-seat rooms, one or
  two 10 to 12-seat, one boardroom only if the brief wants one. Ten huddles
  beat two boardrooms.
- **Focus:** one phone booth or focus room (3 to 4 m²) per 15 to 20 people in
  an open plan.
- **Ask, when it changes the answer:** how many are in on a normal day (hybrid
  offices seat 60 to 70 per cent), whether visitors come (reception and
  meeting rooms near the entrance), whether there are teams that must sit
  together, and whether anything needs a wall (a server room, a lab, a
  recording room).

## 2. Zone the floor before you place a room

Think in four zones, entrance to back:

1. **Front:** reception, waiting, the visitor meeting rooms, the boardroom.
   Visitors never walk through the open plan.
2. **Social:** cafeteria or pantry, breakout, games. Beside the front zone and
   on a window; never beside focus rooms or the server room. Noise stays here.
3. **Work:** the open office, the largest room, on the long window side of the
   building, no deeper than 12 to 15 m from a window. Teams in neighbourhoods
   of 24 to 36 desks, each with a huddle room and a focus booth of its own.
4. **Support:** stores, print, comms, toilets, on the inside of the plan where
   nothing needs a window.

Rules that fall out of this: meeting rooms line the side of the open office
that faces the core, glazed, so they borrow light and stay visible; the
cafeteria is near the entrance (deliveries, visitors, smell away from desks);
toilets are near the core and not next to the cafeteria; the server room is
windowless, away from wet rooms, near IT.

## 3. Sizes and adjacencies to give plan_rooms

- Give `capacity` for every room that holds people; the area follows from it.
- `nextTo`: reception → visitor meeting rooms; cafeteria → pantry or kitchen;
  open office → its huddles and focus rooms; server room → IT team; toilets →
  core, never → cafeteria.
- Glazed: meeting, boardroom, huddle, focus, training, reception face the floor
  through glass; the recipe engine does this for a workplace.
- Corridors 1,500 mm; 1,800 where two people carry things. Doors 900; a
  meeting room's door on the corridor side, its display on the wall opposite.
- Proportion: a meeting room close to square (a 1.1 m wide room holds no
  table); an open office 1 : 1.5 to 1 : 2.5; nothing narrower than 2.7 m.

## 4. Furnish so it reads as an office

- **Open office:** `furnish_room` with recipe `open-office`. Desks 1,600 × 800
  in benches of six (three back to back with three), a chair at each,
  1,500 mm aisles between benches, 1,000 clear behind chairs. Never two
  `arrange` grids — one of desks and one of chairs land on top of each other.
- **Meeting rooms:** `meeting` (4 to 12), `boardroom` (6 to 20), `huddle` (2
  to 5), `training` (21 to 60). Display on the wall opposite the door; farthest
  seat within six diagonals.
- **Cafeteria:** `cafeteria`: four-seat tables in rows, chairs both sides, plus
  a counter along the kitchen wall if the pack has one; a coffee "bar" is a
  counter, not a video bar.
- **Reception:** `reception`: a desk facing the door, seating along a side
  wall.
- **Search the catalog by the product's own category:** desks are `desk`,
  not `table`; a monitor is `display`; a rack is `rack`. When a category
  returns nothing, the warning names where the matches are.

## 5. Before you say it is done

- `validate`: no overlapping items, no blocked doors, no room without a door.
- `render` and look: are the benches benches, is the reception at the
  entrance, is anything a corridor with a name (a room over 1 : 3)? Say what
  is wrong, then fix it.
- Report the m² per person, the meeting seats per head, and what you assumed.

## 6. Drawing the plan yourself

`plan_rooms` gives one shape only: rooms either side of hallways. For anything
with a shape in mind, write the design and give it to `check_design`.

- **Two patterns, and when each suits.** *Rooms around an open centre:* enclosed
  rooms along the walls, the desks in the middle, the open floor as the
  circulation; suits a deep floor with an entrance on one side, and a brief
  that wants the meeting rooms and the cafe on the outside. *A core of rooms:*
  toilets, stores, server, print and the meeting rooms in a block in the
  middle, desks on the glass all round; suits a shallow floor and a brief that
  puts daylight first. Say which you chose and why.
- **Tile it in bands and columns.** Shell first. A band of rooms along one
  side, a column along another, the open floor in what is left. Each room is
  a rectangle inside the shell; neighbours touch, or leave the inside wall's
  thickness between them, and never overlap. Check the arithmetic: x + w of
  one is the x of the next.
- **Say what each room is enclosed by.** `walled` for a room that needs a
  wall; `glass` for meeting, boardroom, huddle, focus and the executive suite;
  `open` for the desks, the cafe, the breakout and the waiting area. Toilets,
  stores, server and comms rooms stay walled whatever you say.
- **Say which sides are glass.** `shell.facade.west: "glazed"` is a glass
  wall the length of that side with no separate windows; every room on it has
  daylight. A modern office glazes one or two sides; a house has windows.
- **Doors.** A walled or glass room lists in `doorsTo` what it opens onto;
  the open floor needs none and counts as reachable for everything touching
  it. The entrance is a door to `outside` on a room against the shell.
- **Fix with `revise_design`, not by re-sending.** Name the rooms and the
  fields: `rooms: [{ key: "meet1", doorsTo: ["corridor"] }, { key: "open",
  enclosure: "open" }]`. A whole design sent again comes back unchanged.
- **Then ask your own questions** with `query_design`: how far are the desks
  from glass (`gapNorth`, `gapSouth` ...), which rooms are slivers (`w / d`
  over 2.5), what touches what (`has(touches, 'cafe')`). Fix what you do not
  like and check again.

## 7. Copying a picture

When the brief says to copy an attached picture:

1. `look_at` it, with its id. Write into notes: the outline's proportions, the
   order of rooms along each side, where the entrance is, which rooms are
   open, which are glass, which sides are glass.
2. Estimate sizes from what the rooms hold: a desk 1.6 × 0.8 m, a bench of
   six about 5 × 3.5, a meeting room for eight about 5 × 4, a door 0.9 m, a
   parking bay 2.5 × 5. The shell follows from the rooms.
3. Draw that arrangement, room by room, in the same order along each side.
   Check; fix errors by moving rectangles; keep the arrangement. Do not hand it
   to `plan_rooms`: the person asked for this picture, not for a plan like it.
