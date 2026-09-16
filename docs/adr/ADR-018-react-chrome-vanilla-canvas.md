# ADR-018: React and shadcn/ui for the chrome, vanilla for the canvas

Status: Accepted. Supersedes ADR-017 D7.
Date: 2026-09-16
Related: ADR-003 (plan view), ADR-005 (bridge), ADR-016 (gestures), ADR-017 (editor shell)

## Context

ADR-017 D7 said the chrome would be plain TypeScript and DOM, with no
framework and no new dependency. Two phases of editor work have tested
that, and it has not held up well.

The chrome is 2 663 lines with 57 hand-written classes, and the widgets
underneath it were hand-rolled: `combobox`, `listbox`, `dialog`,
`toolbar`, `radiogroup`. Five defects reached a running browser in two
days, and every one of them was in that wiring rather than in a rule: a
listener registered on both a parent and its child, a CSS `display` that
beat `[hidden]`, a press that never moved focus, an Escape swallowed as
typing, a bridge result whose `ok` field went unread. None of these could
fail a test, because the test environment is node and has no DOM.

What is still to come is worse: context menus, a level switcher, property
fields, dialogs and a catalog browser. Those are the widgets with the
most demanding keyboard and focus semantics, and writing them by hand
would mean writing the same class of defect again.

The owner of the project is a front-end engineer and asked for shadcn/ui
by name, for consistency across buttons, menus, dialogs and panels.

## Decision

### D1. React owns the chrome; the canvas stays vanilla

React renders the layout grid, the app bar, the tool options bar, the
tool rail, the properties panel, the status bar, the palette and every
dialog. The plan canvases and the three.js viewport are refs that the
existing `startApp` mounts into and continues to own imperatively.

React's reconciler is never in the path of drawing. `PlanRenderer`, the
four stacked canvases, `SceneBinding` and the frame loop are untouched.

### D2. shadcn/ui on Radix and Tailwind v4

Components are added with the shadcn CLI into `apps/web/src/components/ui`
and are then ours to maintain, which is the point: they can be bent to
this project rather than fought. Radix supplies the primitive behaviour,
Tailwind v4 the styling, through `@tailwindcss/vite` with no
`tailwind.config.js`.

Because shadcn ships source rather than a dependency, its components are
not written against this repo's `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess`. Fixing each added component to typecheck is
accepted, expected work, not a signal that something is wrong.

### D3. The seam has rules

Every defect so far has been at a seam, so the seam is specified:

- Canvas pointer and key events stay native listeners on the canvas
  elements. They never rely on React's synthetic event system.
- Exactly one place owns global shortcuts: the command registry. React
  components dispatch commands by id; they do not bind keys themselves.
- Radix traps focus in menus and dialogs and restores it on close. When
  the previously focused element was the canvas, the closing component
  hands focus back to it explicitly.
- Project state reaches React through `useSyncExternalStore` over the
  replica, with a selector per panel, so a patch redraws only what
  changed rather than the whole chrome.

### D4. The framework-free modules survive

`commands`, `keys`, `announce`, `status`, `tools` and `wall-tool` are
plain TypeScript with no DOM in them, and they stay exactly as they are,
consumed by React. Their tests keep running in node.

`roving.ts` is deleted: Radix owns roving tabindex. `palette.ts` is
replaced by the shadcn command component. `shell.ts` becomes components.

### D5. The chrome becomes testable

jsdom and Testing Library are added, and the vitest include glob is
widened to `.tsx`, so chrome behaviour can be tested rather than only
verified by hand in a browser. The rules keep their node tests; a
browser pass stays the final check for gestures on the canvas, which
jsdom cannot exercise.

### D6. What stays out

No state manager, no router, no CSS-in-JS, no React on the host. The
bridge, the replica, the importers and the engine are unchanged.

## Alternatives considered

- **Basecoat plus Zag.js.** shadcn's look as prebuilt CSS with
  framework-agnostic state machines for behaviour, keeping plain
  TypeScript. It would have preserved ADR-017 D7 and cost less, and
  `@zag-js/vanilla` is real. Rejected because the owner asked for
  shadcn itself, and because two half-libraries carry more long-term
  maintenance than one well-trodden one.
- **Zag.js alone**, keeping the current styling. Smallest change, fixes
  the defect class, but leaves the visual system bespoke.
- **A hand-written primitives module.** Zero dependencies, and the
  status quo that produced five defects in two days.
- **Electron readiness as a reason to choose React.** Examined and
  rejected as a factor: Electron is Chromium, and both approaches behave
  identically in it. What makes a desktop build straightforward is the
  host and bridge split that already exists (ADR-005), not the UI
  library.

## Consequences

- The bundle grows by roughly 60 to 90 KB gzipped on top of three.js,
  which already dominates it.
- Around 270 lines of working code, and their tests, are deleted.
- The port is staged: the toolchain first, then the shell chrome, then
  the wall entry card, with the gestures re-verified in a browser after
  each, because that is what caught the last four defects.
- ADR-017 stands except for D7. Its screen budget, tool model, keyboard
  parity and announcements are unchanged, and the shadcn components are
  held to them rather than the other way round.
