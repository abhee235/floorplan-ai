// Primitive recipe meshes (ADR-010 D2 tier 1). Built in item-local plan millimetres: origin at the footprint
// centre, base at z = 0, front toward local -y, converted to metres by the MeshBuilder.
import type { PrimitiveRecipe, Size3 } from "@fpv/ir";
import { derive } from "@fpv/ir";
import { MeshBuilder } from "./mesh.js";
import type { GeometryPart, P3 } from "./types.js";

function box(mb: MeshBuilder, cx: number, cy: number, z0: number, w: number, d: number, h: number): void {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - d / 2;
  const y1 = cy + d / 2;
  const z1 = z0 + h;
  const uv = (p: P3): [number, number] => [p.x / 1000, (p.y + p.z) / 1000];
  mb.addFace(
    [
      { x: x0, y: y0, z: z1 },
      { x: x1, y: y0, z: z1 },
      { x: x1, y: y1, z: z1 },
      { x: x0, y: y1, z: z1 },
    ],
    { x: 0, y: 0, z: 1 },
    uv,
  );
  mb.addFace(
    [
      { x: x0, y: y0, z: z0 },
      { x: x1, y: y0, z: z0 },
      { x: x1, y: y1, z: z0 },
      { x: x0, y: y1, z: z0 },
    ],
    { x: 0, y: 0, z: -1 },
    uv,
  );
  mb.addFace(
    [
      { x: x0, y: y0, z: z0 },
      { x: x1, y: y0, z: z0 },
      { x: x1, y: y0, z: z1 },
      { x: x0, y: y0, z: z1 },
    ],
    { x: 0, y: -1, z: 0 },
    uv,
  );
  mb.addFace(
    [
      { x: x0, y: y1, z: z0 },
      { x: x1, y: y1, z: z0 },
      { x: x1, y: y1, z: z1 },
      { x: x0, y: y1, z: z1 },
    ],
    { x: 0, y: 1, z: 0 },
    uv,
  );
  mb.addFace(
    [
      { x: x0, y: y0, z: z0 },
      { x: x0, y: y1, z: z0 },
      { x: x0, y: y1, z: z1 },
      { x: x0, y: y0, z: z1 },
    ],
    { x: -1, y: 0, z: 0 },
    uv,
  );
  mb.addFace(
    [
      { x: x1, y: y0, z: z0 },
      { x: x1, y: y1, z: z0 },
      { x: x1, y: y1, z: z1 },
      { x: x1, y: y0, z: z1 },
    ],
    { x: 1, y: 0, z: 0 },
    uv,
  );
}

function cylinder(
  mb: MeshBuilder,
  cx: number,
  cy: number,
  z0: number,
  diameter: number,
  h: number,
  segments = 24,
): void {
  const r = diameter / 2;
  const ring = (z: number) =>
    Array.from({ length: segments }, (_, i) => {
      const a = (2 * Math.PI * i) / segments;
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z };
    });
  const bottom = ring(z0);
  const top = ring(z0 + h);
  mb.addFace(top, { x: 0, y: 0, z: 1 }, (p) => [p.x / 1000, p.y / 1000]);
  mb.addFace(bottom, { x: 0, y: 0, z: -1 }, (p) => [p.x / 1000, p.y / 1000]);
  for (let i = 0; i < segments; i += 1) {
    const a = bottom[i] as P3;
    const b = bottom[(i + 1) % segments] as P3;
    const c = top[(i + 1) % segments] as P3;
    const d = top[i] as P3;
    mb.addFace([a, b, c, d], { x: a.x - cx + b.x - cx, y: a.y - cy + b.y - cy, z: 0 }, (p) => [
      (i + (p === b || p === c ? 1 : 0)) / segments,
      p.z / 1000,
    ]);
  }
}

const LEG = 50;

export function recipeAssetKey(recipe: PrimitiveRecipe): string {
  const s = derive.recipeSize(recipe);
  const extra = recipe.kind === "table" ? `:${recipe.shape}` : "";
  return `recipe:${recipe.kind}${extra}:${s.w}x${s.d}x${s.h}`;
}

/** Build a recipe mesh at its exact size; the item instance then carries only rotation and translation. */
export function buildRecipe(recipe: PrimitiveRecipe): GeometryPart {
  const mb = new MeshBuilder();
  const s: Size3 = derive.recipeSize(recipe);
  switch (recipe.kind) {
    case "box":
    case "video-bar":
    case "ceiling-mic":
      box(mb, 0, 0, 0, s.w, s.d, s.h);
      break;
    case "cylinder":
    case "ceiling-speaker":
      cylinder(mb, 0, 0, 0, s.w, s.h);
      break;
    case "display": {
      box(mb, 0, 0, 0, s.w, s.d, s.h); // panel
      break;
    }
    case "table": {
      const topT = Math.min(40, s.h / 4);
      if (recipe.shape === "round") cylinder(mb, 0, 0, s.h - topT, Math.min(s.w, s.d), topT, 32);
      else box(mb, 0, 0, s.h - topT, s.w, s.d, topT);
      const inset = Math.min(150, s.w / 4, s.d / 4);
      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          box(mb, sx * (s.w / 2 - inset), sy * (s.d / 2 - inset), 0, LEG, LEG, s.h - topT);
      break;
    }
    case "chair": {
      const seatZ = Math.round(s.h * 0.48);
      box(mb, 0, 0, seatZ, s.w, s.d, 50); // seat
      box(mb, 0, s.d / 2 - 25, seatZ + 50, s.w, 50, s.h - seatZ - 50); // back at local +y
      const inset = Math.min(60, s.w / 4, s.d / 4);
      for (const sx of [-1, 1])
        for (const sy of [-1, 1]) box(mb, sx * (s.w / 2 - inset), sy * (s.d / 2 - inset), 0, LEG, LEG, seatZ);
      break;
    }
  }
  return mb.toPart(recipeAssetKey(recipe), "recipe", `recipe:${recipe.kind}`);
}
