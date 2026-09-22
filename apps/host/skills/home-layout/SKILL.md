---
name: home-layout
description: How a home is zoned, sized and furnished, from a family's brief to the rooms
whenToUse: before designing any dwelling: a flat, a house, a villa, a floor of one
---

# Home layout

What somebody who plans houses for a living knows, in the order they use it.

## 1. Read the brief for what it does not say

- **Every home has:** a kitchen, a bathroom, a living room, an entrance, and
  storage, whether or not they were listed. The checker refuses a dwelling
  without the first three. Add what is missing and say so.
- **The vocabulary is the client's.** In an Indian brief a *hall* is the living
  room, a *lobby* the entrance foyer, a *wash area* the utility, a *pooja room*
  a small prayer room; a British *hall* is the corridor by the front door. One
  question is worth asking when a word means two rooms.
- **Ask, when it changes the answer:** how many people and who (a parent who
  cannot climb stairs wants a ground-floor bedroom and bathroom), whether they
  cook daily (a working kitchen wants 10 m² and a window), whether anybody
  works from home, and what cannot be moved on the plot: the road, the
  neighbour's wall, where the sun rises.

## 2. Zone the plan before you place a room

Three zones, front to back:

1. **Public:** foyer, living, dining, a guest toilet by the entrance. Visitors
   see these and nothing else.
2. **Service:** kitchen with the dining beside it, utility or laundry behind
   the kitchen, store. The kitchen is near the entrance or the garage, because
   that is where the shopping comes in.
3. **Private:** bedrooms with their bathrooms, off a short corridor, away from
   the front door and the living room's noise. The main bedroom farthest from
   the entrance, with its own bathroom.

Rules that fall out of this: wet rooms share walls (kitchen, bathrooms, utility
back to back on one drainage line); a bathroom opens off a corridor, never off
the living room or another bedroom, except the main bedroom's own; the living
room and the main bedroom get the best side (south or west light, the view);
the kitchen gets morning light (east) if it can; the stair, if there is one,
is by the entrance.

## 3. Sizes and adjacencies to give plan_rooms

- Areas in m²: main bedroom 14 to 16; double bedroom 12; single 9 to 10;
  living 18 to 24 (28 with dining in it); dining 10 to 12; kitchen 8 to 12;
  bathroom 4 to 6; toilet 2; foyer 3 to 4; utility 4 to 5; store 2 to 3.
  A three-bedroom home is 95 to 120 m² gross; if yours is 60 the rooms are
  too small.
- `nextTo`: kitchen → dining; utility → kitchen; main bedroom → its bathroom;
  foyer → living; guest toilet → foyer.
- `window: true` on every habitable room (bedrooms, living, dining, kitchen,
  study); toilets and stores may do without.
- Corridors 1,050 mm, 1,200 where a wheelchair turns; doors 900 (750 for a
  bathroom, 1,000 at the entrance). Nothing narrower than 2.4 m; a bedroom is
  close to square, a living room up to 1 : 1.6.

## 4. Furnish so it reads as a home

- `furnish_room` with the pack's recipes: `bedroom` (double bed with its back to
  a wall, wardrobe, 700 mm free beside the bed), `bedroom-single`, `living`
  (sofa facing the television wall, 2,500 mm apart), `dining`, `kitchen` (a
  run along the longest free wall), `bathroom`, `toilet`, `study`, `laundry`.
- A television goes on the wall facing the sofa, never on a window wall; a
  wardrobe needs 900 mm in front of its doors; a bed is got into from the side.
- Search the catalog by the product's own category: `bed`, `wardrobe`, `sofa`,
  `kitchen-run`, `sanitary`, `appliance`.

## 5. Before you say it is done

- `validate`: every bedroom has a bed that fits, no bathroom opens off a
  living room, doors swing clear, nothing overlaps.
- `render` and look: does the entrance lead to the living room and not to a
  bedroom door, is the kitchen next to the dining, is any room a corridor with
  a name? Say what is wrong, then fix it.
- Report the gross area, the bedrooms with their sizes, and what you assumed.
