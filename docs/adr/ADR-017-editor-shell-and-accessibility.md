# ADR-017: Editor shell, tool model and keyboard parity

Status: Proposed
Date: 2026-09-16
Related: ADR-003 (plan view), ADR-004 (commands), ADR-006 (tool surface), ADR-016 (gestures)

## Context

Phase 3 gives a person the editor: drawing walls and rooms, moving items,
selecting and undoing, without an agent. The geometry underneath is built and
tested; what is missing is the chrome around the canvas and the interaction
model. Two things decide whether this feels like a real tool: where the screen
goes, and whether every gesture has a keyboard equal.

The owner of this project is a front-end engineer and asked for a considered,
accessible interface rather than a sketch. Reference layouts were compared
before deciding (a design-tool layout with a properties panel bound to the
selection; a modelling application's non-overlapping resizable areas with a
status bar; CAD conventions of typed lengths and a command line), and the
keyboard model follows the ARIA authoring practices for toolbars and for
keyboard interfaces.

## Decision

### D1. Plan-led shell, panels always open

One non-overlapping grid at 1440x900: app bar 36 px, tool options bar 30 px,
body, status bar 28 px; the body is a 44 px tool rail, the canvas stack, and a
296 px properties panel. The plan is the working surface and the 3D view is
docked beneath it at 232 px, collapsible and enlargeable; a view switch offers
plan only, plan and 3D, or 3D only. That leaves 1100x566 for the plan with 3D
docked and 1100x798 without it. Panels are resizable and their sizes persist.

Nothing floats over the canvas except the zoom cluster, the command palette and
transient drawing feedback. Panels are always present rather than summoned:
discoverability beats canvas area for a tool people use daily.

### D2. Tools are modes with their own options bar

Select, wall, room, opening, item, measure, annotate, and pan. One letter each
(V, W, R, O, I, M, T; space for pan), Escape returns to select. The tool owns
the options bar under the app bar: its defaults (wall thickness and kind),
the snapping switches, and a plain sentence naming the modifiers. Snapping is
a preference the modifier keys invert (W-082): Alt bypasses, Shift aligns.

### D3. The properties panel is the selection

Empty selection shows the level and the defaults for new entities. One entity
shows its own fields, grouped: position, size, placement, problems, actions.
A multiple selection shows the fields the entities share. Every length is a
number in millimetres, right-aligned, tabular; degrees for angles. Problems for
the selection are stated in words, not codes. The panel is also where the
catalog and the level list live, as sibling tabs.

Amendment 2026-09-17 (P3-5): the panel takes its shape from a design tool's,
to keep a selection on one screen, but keeps this app's own parts. Under a
title, each group is a band with a heading at 13 px over a grid of at most two
fields to a line; a name, a surface's colour and material, or any value that
needs the room takes the whole line. Every field is the app's own component,
26 px high, its value at 13 px and its caption at 12 px, on a quiet fill with
no border until the pointer is on it; a value that is only read has neither. Every number carries a
letter at its left edge saying which number it is — X, W, HE — and that letter
is the one handle for dragging the value; the arrow keys step it from the field
itself. Lengths are left-aligned and tabular, with the unit inside the field.
The level's own values show only while nothing is selected.

### D4. Every gesture has a keyboard equal

The tab sequence is the shell: app bar, tool options, tool rail, canvas,
properties, status. Toolbars are one tab stop with roving tabindex and arrow
keys. The canvas is one tab stop entered with Enter and left with Escape;
inside it Tab steps entities in hit order, arrows nudge by a grid step (Shift
for 10 mm), Space picks up and drops with Escape cancelling, brackets rotate by
15 degrees, Enter opens the entity in the properties panel.

Drawing by typing is the same gesture as drawing by pointer: length, Tab,
angle, Enter places the segment; Enter twice ends the chain; the angle is
relative to the previous wall and absolute for the first (W-072..W-076). A
command palette on Ctrl+K lists every command with its shortcut, which is how
shortcuts stay discoverable.

### D5. Announcements

One polite live region carries gesture feedback (the length and angle being
drawn, what a snap caught, what was selected and where it sits). One assertive
region carries refusals and validation errors. Both say what happened and what
to do, never a code.

### D6. Visual system

The existing tokens: system-ui at 13 px, #2b2b2b on #f3f1ec, white chrome with
#e0ddd6 borders, 4 px radii, #faf9f6 controls with #c9c5bd borders, #1e6fd9 for
primary actions, and the plan palette already in use (#e6e3dd grid, #3a3a3a
walls, #1e88e5 selection, #2e7d32 / #1565c0 / #6d4c41 for door, window and
passage). Focus is a 2 px #1e6fd9 ring with a 2 px offset, on canvas entities
as well as controls. Controls are 32 px on a pointer and 44 px on touch, where
indicator margins already triple (W-091, R-049). Contrast meets WCAG 2.2 AA;
motion respects reduced-motion.

### D7. Built as the rest of the app is

Plain TypeScript and DOM for the chrome, the four stacked canvases for the plan
(ADR-003 D6), no framework and no new dependency. Every gesture opens one
transaction and commits or rolls back as ADR-016 D5 already specifies, so the
editor emits exactly the commands the tools do.

## Alternatives considered

- **A ribbon across the top.** Familiar from CAD, but it costs 90 to 120 px of
  vertical space permanently and hides tools behind tabs.
- **Floating panels that appear with a selection.** More canvas, worse
  discoverability, and the canvas jumps as panels appear.
- **3D as the main surface.** Rejected: the precise work is in the plan, and a
  drafting tool that leads with a perspective view reads as a visualiser.
- **Keyboard support only in panels.** Rejected: it would leave the canvas,
  where the work happens, unusable without a mouse.

## Consequences

- The shell needs a small interaction layer (focus regions, roving toolbars,
  a live-region announcer, a command registry) before P3-1 lands; the command
  registry is also what the palette and the shortcut list read from.
- Every tool must state its options, its shortcut and its keyboard path, or it
  cannot be added to the rail.
- The ledger rows for phase 3 (W-067..W-091, R-041..R-060, F-100..F-118,
  F-130..F-170) are the acceptance list for the interaction layer.
- A design canvas of the shell, the drawing state, the selection state, the
  palette and the keyboard map is kept in `.design` and published for review.
