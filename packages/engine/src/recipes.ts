// Primitive recipe meshes (ADR-010 D2 tier 1). Built in item-local plan millimetres: origin at the footprint
// centre, base at z = 0, front toward local -y, converted to metres by the MeshBuilder.
import type { RecipeKind } from "@fpv/assets";
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

/** How far a display's screen stands proud of its panel, so the two never fight for the same depth. */
const SCREEN_PROUD = 1;

/** Builds a recipe's shape, asking `at` for the builder of each part (derive.recipeSlots names them). */
function shape(recipe: PrimitiveRecipe, s: Size3, at: (slot: string) => MeshBuilder): void {
  switch (recipe.kind) {
    case "box":
    case "video-bar":
    case "ceiling-mic":
      box(at("body"), 0, 0, 0, s.w, s.d, s.h);
      break;
    case "cylinder":
    case "ceiling-speaker":
      cylinder(at("body"), 0, 0, 0, s.w, s.h);
      break;
    case "display": {
      box(at("frame"), 0, 0, 0, s.w, s.d, s.h); // panel
      // the screen, inside the bezel on the front face (local -y)
      const inset = Math.min(recipe.bezelMm, s.w / 4, s.h / 4);
      const y = -s.d / 2 - SCREEN_PROUD;
      at("screen").addFace(
        [
          { x: -s.w / 2 + inset, y, z: inset },
          { x: s.w / 2 - inset, y, z: inset },
          { x: s.w / 2 - inset, y, z: s.h - inset },
          { x: -s.w / 2 + inset, y, z: s.h - inset },
        ],
        { x: 0, y: -1, z: 0 },
        (p) => [(p.x + s.w / 2) / 1000, p.z / 1000],
      );
      break;
    }
    case "table": {
      const topT = Math.min(40, s.h / 4);
      if (recipe.shape === "round") cylinder(at("top"), 0, 0, s.h - topT, Math.min(s.w, s.d), topT, 32);
      else box(at("top"), 0, 0, s.h - topT, s.w, s.d, topT);
      const inset = Math.min(150, s.w / 4, s.d / 4);
      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          box(at("legs"), sx * (s.w / 2 - inset), sy * (s.d / 2 - inset), 0, LEG, LEG, s.h - topT);
      break;
    }
    case "chair": {
      const seatZ = Math.round(s.h * 0.48);
      box(at("fabric"), 0, 0, seatZ, s.w, s.d, 50); // seat
      box(at("fabric"), 0, s.d / 2 - 25, seatZ + 50, s.w, 50, s.h - seatZ - 50); // back at local +y
      const inset = Math.min(60, s.w / 4, s.d / 4);
      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          box(at("frame"), sx * (s.w / 2 - inset), sy * (s.d / 2 - inset), 0, LEG, LEG, seatZ);
      break;
    }
  }
}

/** Build a recipe mesh at its exact size, all in one part; the item instance carries only its transform. */
export function buildRecipe(recipe: PrimitiveRecipe): GeometryPart {
  const mb = new MeshBuilder();
  shape(recipe, derive.recipeSize(recipe), () => mb);
  return mb.toPart(recipeAssetKey(recipe), "recipe", `recipe:${recipe.kind}`);
}

/** The material key of one part of a recipe, before any finish: "chair/fabric". */
export function recipeSlotKey(kind: PrimitiveRecipe["kind"], slot: string): string {
  return `${kind}/${slot}`;
}

/**
 * A recipe mesh at its exact size, one part per material slot in the recipe's slot order, so each part can
 * take its own material (P3-5: a chair's fabric changes without its frame).
 */
export function buildRecipeParts(recipe: PrimitiveRecipe): (GeometryPart & { slot: string })[] {
  const builders = new Map<string, MeshBuilder>();
  const at = (slot: string): MeshBuilder => {
    const known = builders.get(slot);
    if (known) return known;
    const made = new MeshBuilder();
    builders.set(slot, made);
    return made;
  };
  shape(recipe, derive.recipeSize(recipe), at);
  const key = recipeAssetKey(recipe);
  return derive.recipeSlots(recipe.kind).flatMap((slot) => {
    const mb = builders.get(slot);
    return mb && !mb.isEmpty ? [{ ...mb.toPart(key, "recipe", recipeSlotKey(recipe.kind, slot)), slot }] : [];
  });
}

/**
 * The recipe a product without a model of its own is drawn as (spec 02 section 3.1), at the product's size.
 * A display is built from the diagonal its width and height give; the item's matrix then scales whatever
 * the recipe comes to onto the product's exact size.
 */
export function fallbackRecipe(kind: RecipeKind, size: Size3, label: string): PrimitiveRecipe {
  switch (kind) {
    case "table":
      return { kind, size, shape: "rect" };
    case "chair":
    case "video-bar":
    case "ceiling-mic":
      return { kind, size };
    case "display":
      return { kind, diagonalIn: Math.hypot(size.w, size.h) / 25.4, bezelMm: 0 };
    case "ceiling-speaker":
      return { kind, diameter: size.w };
    case "cylinder":
      return { kind, diameter: size.w, height: size.h, label };
    case "box":
      return { kind, size, label };
  }
}
