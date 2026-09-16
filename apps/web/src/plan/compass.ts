// The north arrow on the plan (ADR-006 D3). A floor plan without an orientation is ambiguous in a way
// that matters: which rooms get morning light, which facade faces the street, which way a door swings
// relative to the building. The IR already carries the answer as `meta.north`, so this draws real data
// rather than a decoration.
//
// It is drawn in SCREEN space, not plan space: the compass keeps its size and its corner whatever the
// zoom, because it describes the drawing rather than belonging to it.
//
// That takes a deliberate act. PlanRenderer.begin installs one transform per layer —
// setTransform(scale, 0, 0, -scale, offsetX, offsetY), scaled and y-flipped into plan millimetres — and
// overlayExtra painters are handed the context with it still live. The first version of this file ignored
// that and placed the compass at (31, 303), which the transform read as millimetres: at 1:76 it landed
// hundreds of metres off-canvas and drew nothing at all. So the transform is reset to identity here and
// restored afterwards, which is exactly what Ctx2D exposes save/restore/setTransform for.
//
// Sizes come from `view` alone, never multiplied by devicePixelRatio: view.width and view.height ARE the
// device-pixel buffer dimensions (app.ts sizes the canvases with plan.resize(pw * dpr, ph * dpr)), so
// scaling by dpr again would double every margin on a HiDPI screen.

import type { Ctx2D, PlanView } from "./plan.js";

/** Distance from the bottom-left corner of the plan, in screen pixels. */
const MARGIN = 16;
const RADIUS = 15;

/**
 * Screen rotation for a project north, clockwise from straight up, in radians.
 *
 * `meta.north` is a plan-space angle measured counter-clockwise from +X, the same convention
 * `derive.compassOf` uses. Screen Y is flipped against plan Y (`toScreen` computes `offsetY - y * scale`),
 * so a counter-clockwise plan angle becomes a clockwise screen angle. North of 90 degrees — plan +Y, the
 * usual case — must therefore come out as zero rotation: straight up.
 */
export function northScreenRadians(northDeg: number): number {
  return ((90 - northDeg) * Math.PI) / 180;
}

/** Draw the north arrow in the lower-left of the plan. `northDeg` is `project.meta.north`. */
export function drawCompass(ctx: Ctx2D, view: PlanView, northDeg: number): void {
  // Out of plan millimetres and into device pixels for the duration. drawOverlay already wraps this
  // painter in its own save/restore, but the balance is kept here too: the review panel and the wall
  // preview draw in the same composition and must not inherit an identity transform from the compass.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const cx = MARGIN + RADIUS;
  const cy = view.height - (MARGIN + RADIUS);
  const r = RADIUS;
  const dpr = 1; // widths are already in device pixels under the identity transform

  // The rotation is done here in plain trigonometry rather than with ctx.translate/ctx.rotate, because
  // Ctx2D is a deliberately narrow subset of CanvasRenderingContext2D — the plan renderer is driven by a
  // fake context under node so it can be tested without a DOM, and those two are not in the subset.
  // Widening the interface to get them would break the doubles as a silent test failure rather than a
  // type error. Six points are cheap to rotate by hand, and doing it this way keeps the "N" upright for
  // free instead of needing a counter-rotation.
  const a = northScreenRadians(northDeg);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const at = (x: number, y: number): [number, number] => [cx + x * cos - y * sin, cy + x * sin + y * cos];
  const poly = (points: [number, number][]): void => {
    ctx.beginPath();
    const [first, ...rest] = points;
    if (!first) return;
    ctx.moveTo(first[0], first[1]);
    for (const [x, y] of rest) ctx.lineTo(x, y);
    ctx.closePath();
  };

  // A disc behind it, so the arrow stays readable over walls and over the grid alike. The circle is
  // rotation-invariant, so it is drawn at the centre directly.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.fill();
  ctx.lineWidth = dpr;
  ctx.strokeStyle = "#c8ccd4";
  ctx.stroke();

  const tip = at(0, -r * 0.62);
  const tail = at(0, r * 0.14);

  // The needle: the filled half points north, the hollow half south. That contrast is what makes the
  // direction readable at a glance, without having to find the letter first.
  poly([tip, at(r * 0.3, r * 0.34), tail]);
  ctx.fillStyle = "#1e88e5";
  ctx.fill();

  poly([tip, at(-r * 0.3, r * 0.34), tail]);
  ctx.fillStyle = "rgba(30,136,229,0.28)";
  ctx.fill();
  ctx.lineWidth = dpr;
  ctx.strokeStyle = "#1e88e5";
  ctx.stroke();

  // The "N" sits beyond the tip and is never itself rotated: a letter that has moved is far easier to
  // read than a letter lying on its side.
  const [nx, ny] = at(0, -r * 1.42);
  ctx.fillStyle = "#3f3f46";
  ctx.font = `${Math.round(10 * dpr)}px Inter Variable, Inter, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("N", nx, ny);

  ctx.restore(); // back to plan millimetres for whatever paints next
}
