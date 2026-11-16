// Turn each plan spec into three files under tools/fixtures/plans-pictures/<name>/:
//   draw.json      — what to draw, in pixels, in the plan's style (render.ps1 turns it into picture.png)
//   reference.json — the project the picture shows, which a run is scored against (tools/eval/fidelity.ts)
//   card.json      — the live eval card (tools/eval/live.ts --card-file)
// Usage: tsx tools/eval/pictures/build.ts, then powershell -File tools/eval/pictures/render.ps1
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ItemSpec, PLANS, type PlanSpec, type Pt } from "./specs.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = join(ROOT, "tools/fixtures/plans-pictures");
const MARGIN = 40;
const SCALE_ANSWER =
  "I don't know the real size. Choose a scale from things in the picture whose size you know, say what you based it on, and carry on.";
const ANSWERS = {
  scale: SCALE_ANSWER,
  dimension: SCALE_ANSWER,
  millimetre: SCALE_ANSWER,
  length: SCALE_ANSWER,
  "*": "Yes, go ahead, and draw everything the picture shows, furniture included, as well as you can read it.",
};

type Op =
  | { op: "line"; pts: Pt[]; w: number; c: string }
  | { op: "poly"; pts: Pt[]; fill?: string; stroke?: string; w?: number }
  | { op: "circle"; c: Pt; r: number; w: number; stroke: string; fill?: string }
  | { op: "text"; at: Pt; text: string; size: number; font: string };

/** A deterministic wobble for the hand-drawn style, so the picture is the same every build. */
function wobble(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296 - 0.5;
  };
}

function build(plan: PlanSpec) {
  const [W, H] = plan.size;
  const k = 1 / plan.scale;
  const px = (p: Pt): Pt => [MARGIN + p[0] * k, MARGIN + (H - p[1]) * k];
  const sketch = plan.style === "sketch";
  const jit = wobble(plan.name.length * 7919);
  const j = (p: Pt, amount = 1.2): Pt => (sketch ? [p[0] + jit() * amount, p[1] + jit() * amount] : p);
  const ops: Op[] = [];
  const ink = "#1a1a1a";
  const line = (pts: Pt[], w: number, c = ink) => ops.push({ op: "line", pts: pts.map((p) => j(p)), w, c });

  // ---- walls ---------------------------------------------------------------------------------
  for (const wall of plan.walls) {
    const [ax, ay] = wall.a;
    const [bx, by] = wall.b;
    const len = Math.hypot(bx - ax, by - ay);
    const u: Pt = [(bx - ax) / len, (by - ay) / len];
    const n: Pt = [-u[1], u[0]];
    const h = wall.thick / 2;
    // Extended by half a thickness at both ends, so corners close.
    const a: Pt = [ax - u[0] * h, ay - u[1] * h];
    const b: Pt = [bx + u[0] * h, by + u[1] * h];
    const edge = (s: number): Pt[] => [
      px([a[0] + n[0] * h * s, a[1] + n[1] * h * s]),
      px([b[0] + n[0] * h * s, b[1] + n[1] * h * s]),
    ];
    if (wall.kind === "glass") {
      ops.push({ op: "poly", pts: [...edge(1), ...edge(-1).reverse()], fill: "#e6f0fa" });
      line(edge(1), 1);
      line(edge(-1), 1);
      line([px(wall.a), px(wall.b)], 0.8, "#6c8fb3");
    } else if (plan.style === "double") {
      line(edge(1), 1.6);
      line(edge(-1), 1.6);
    } else if (plan.style === "hatched") {
      ops.push({
        op: "poly",
        pts: [...edge(1), ...edge(-1).reverse()],
        fill: "#ffffff",
        stroke: ink,
        w: 1.4,
      });
      // Diagonal strokes across the band, every few pixels along it.
      const step = 5 * plan.scale;
      for (let t = 0; t + wall.thick < len + wall.thick; t += step) {
        const p: Pt = [a[0] + u[0] * t, a[1] + u[1] * t];
        const q: Pt = [p[0] + u[0] * wall.thick, p[1] + u[1] * wall.thick];
        line([px([p[0] + n[0] * h, p[1] + n[1] * h]), px([q[0] - n[0] * h, q[1] - n[1] * h])], 0.8);
      }
    } else {
      // A marker line along the centre, drawn twice as a hand would.
      const pts: Pt[] = [];
      const steps = Math.max(2, Math.round(len / 400));
      for (let i = 0; i <= steps; i += 1)
        pts.push(px([a[0] + (b[0] - a[0]) * (i / steps), a[1] + (b[1] - a[1]) * (i / steps)]));
      line(pts, Math.max(2.5, wall.thick * k * 0.6));
      line(pts, 1.2);
    }
  }

  // ---- openings: cut the gap, then draw what is in it ------------------------------------------
  const referenceOpenings: { wallId: string; position: number; kind: string; width: number }[] = [];
  for (const o of plan.openings) {
    const wall = plan.walls[o.wall] as PlanSpec["walls"][number];
    const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
    const u: Pt = [(wall.b[0] - wall.a[0]) / len, (wall.b[1] - wall.a[1]) / len];
    const n: Pt = [-u[1], u[0]];
    const at = (t: number, off = 0): Pt => [
      wall.a[0] + u[0] * t + n[0] * off,
      wall.a[1] + u[1] * t + n[1] * off,
    ];
    const s0 = o.at - o.width / 2;
    const s1 = o.at + o.width / 2;
    const h = wall.thick / 2 + 1.5 * plan.scale;
    ops.push({
      op: "poly",
      pts: [px(at(s0, h)), px(at(s1, h)), px(at(s1, -h)), px(at(s0, -h))],
      fill: "#ffffff",
    });
    const jamb = (t: number) => line([px(at(t, wall.thick / 2)), px(at(t, -wall.thick / 2))], 1.2);
    const leaf = (hinge: number, towards: number, width: number, side: number) => {
      const hp = at(hinge);
      const tip: Pt = [hp[0] + n[0] * side * width, hp[1] + n[1] * side * width];
      line([px(hp), px(tip)], sketch ? 1.6 : 1.3);
      if (sketch) return; // a hand sketch draws the leaf and no arc
      const pts: Pt[] = [];
      for (let i = 0; i <= 24; i += 1) {
        const f = (i / 24) * (Math.PI / 2);
        const dir = towards - hinge > 0 ? 1 : -1;
        pts.push(
          px([
            hp[0] + n[0] * side * width * Math.cos(f) + u[0] * dir * width * Math.sin(f),
            hp[1] + n[1] * side * width * Math.cos(f) + u[1] * dir * width * Math.sin(f),
          ]),
        );
      }
      line(pts, 0.9, "#555555");
    };
    const side = o.side ?? 1;
    if (o.kind === "door") {
      jamb(s0);
      jamb(s1);
      if (o.hinge === "end") leaf(s1, s0, o.width, side);
      else leaf(s0, s1, o.width, side);
      referenceOpenings.push({ wallId: `w${o.wall}`, position: o.at / len, kind: "door", width: o.width });
    } else if (o.kind === "double") {
      jamb(s0);
      jamb(s1);
      leaf(s0, o.at, o.width / 2, side);
      leaf(s1, o.at, o.width / 2, side);
      // One opening, as the app builds a double door: a door with a double-leaf recipe.
      referenceOpenings.push({ wallId: `w${o.wall}`, position: o.at / len, kind: "door", width: o.width });
    } else if (o.kind === "window") {
      jamb(s0);
      jamb(s1);
      if (sketch) line([px(at(s0)), px(at(s1))], 1.1);
      else {
        line([px(at(s0, wall.thick / 4)), px(at(s1, wall.thick / 4))], 0.9);
        line([px(at(s0, -wall.thick / 4)), px(at(s1, -wall.thick / 4))], 0.9);
      }
      referenceOpenings.push({ wallId: `w${o.wall}`, position: o.at / len, kind: "window", width: o.width });
    } else {
      jamb(s0);
      jamb(s1);
      referenceOpenings.push({ wallId: `w${o.wall}`, position: o.at / len, kind: "passage", width: o.width });
    }
  }

  // ---- furniture -----------------------------------------------------------------------------
  const local = (it: ItemSpec, lx: number, ly: number): Pt => {
    const r = ((it.rot ?? 0) * Math.PI) / 180;
    return px([
      it.at[0] + lx * Math.cos(r) - ly * Math.sin(r),
      it.at[1] + lx * Math.sin(r) + ly * Math.cos(r),
    ]);
  };
  const box = (it: ItemSpec, x0: number, y0: number, x1: number, y1: number, w = 1.1) =>
    line(
      [local(it, x0, y0), local(it, x1, y0), local(it, x1, y1), local(it, x0, y1), local(it, x0, y0)],
      w,
      "#444444",
    );
  for (const it of plan.items) {
    const hw = it.w / 2;
    const hd = it.d / 2;
    if (it.kind === "round" || it.kind === "plant") {
      ops.push({ op: "circle", c: j(px(it.at)), r: hw * k, w: 1.1, stroke: "#444444" });
      if (it.kind === "plant") {
        line([local(it, -hw * 0.6, 0), local(it, hw * 0.6, 0)], 0.8, "#666666");
        line([local(it, 0, -hd * 0.6), local(it, 0, hd * 0.6)], 0.8, "#666666");
      }
      continue;
    }
    box(it, -hw, -hd, hw, hd);
    // The back is local +y: a headboard, a sofa back, a chair back.
    if (it.kind === "bed") box(it, -hw * 0.8, hd * 0.55, hw * 0.8, hd * 0.9, 0.9);
    if (it.kind === "sofa") {
      box(it, -hw, hd * 0.45, hw, hd, 0.9);
      box(it, -hw, -hd, -hw * 0.82, hd, 0.9);
      box(it, hw * 0.82, -hd, hw, hd, 0.9);
    }
    if (it.kind === "chair") line([local(it, -hw, hd * 0.6), local(it, hw, hd * 0.6)], 0.9, "#444444");
  }

  // ---- labels --------------------------------------------------------------------------------
  for (const r of plan.rooms)
    ops.push({
      op: "text",
      at: px(r.label),
      text: r.name,
      size: sketch ? 15 : 13,
      font: sketch ? "Segoe Print" : "Arial",
    });

  // ---- the reference project -----------------------------------------------------------------
  const recipeOf: Record<ItemSpec["kind"], string> = {
    bed: "bed",
    sofa: "sofa",
    table: "table",
    desk: "table",
    chair: "chair",
    box: "box",
    round: "cylinder",
    plant: "cylinder",
  };
  const reference = {
    note: `The reference for ${plan.name}: what the picture shows, from tools/eval/pictures/specs.ts.`,
    walls: plan.walls.map((w, i) => ({
      id: `w${i}`,
      start: { x: w.a[0], y: w.a[1] },
      end: { x: w.b[0], y: w.b[1] },
      thickness: w.thick,
      kind: w.kind ?? "interior",
    })),
    openings: referenceOpenings,
    rooms: plan.rooms.map((r) => ({ name: r.name, polygon: r.polygon.map(([x, y]) => ({ x, y })) })),
    items: plan.items.map((it) => ({
      position: { x: it.at[0], y: it.at[1] },
      rotation: it.rot ?? 0,
      ref: { kind: "recipe", recipe: { kind: recipeOf[it.kind] } },
    })),
  };

  const dir = join(OUT, plan.name);
  mkdirSync(dir, { recursive: true });
  const size: Pt = [Math.round(W * k + 2 * MARGIN), Math.round(H * k + 2 * MARGIN)];
  writeFileSync(join(dir, "draw.json"), `${JSON.stringify({ size, ops })}\n`);
  writeFileSync(join(dir, "reference.json"), `${JSON.stringify(reference, null, 1)}\n`);
  const rel = `tools/fixtures/plans-pictures/${plan.name}`;
  writeFileSync(
    join(dir, "card.json"),
    `${JSON.stringify(
      {
        id: `picture-${plan.name}`,
        title: plan.title,
        task: "Here is a picture of a floor plan. Draw it in this project as it is: the walls, doors, windows, the named areas and the furniture. If the picture has no dimensions, choose a scale from what is in it and tell me what you chose and why.",
        maxSteps: 80,
        attach: { path: `${rel}/picture.png`, mime: "image/png" },
        readWith: "code",
        reference: `${rel}/reference.json`,
        heldOut: plan.heldOut === true,
        fidelity: { overall: 0.8 },
        // What a person without the measurements says: choose one, and say why.
        answers: ANSWERS,
        expect: { maxValidationErrors: 0 },
      },
      null,
      2,
    )}\n`,
  );
  return {
    name: plan.name,
    size,
    ops: ops.length,
    openings: referenceOpenings.length,
    items: plan.items.length,
  };
}

for (const plan of PLANS) console.log(JSON.stringify(build(plan)));
