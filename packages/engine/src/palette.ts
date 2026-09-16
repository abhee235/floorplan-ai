// Flat colours per material key (ADR-003 D4, ADR-013 D4). One palette for the viewer and the glTF export, so an
// exported scene looks like the one on screen. Colours are sRGB hex.

export const MATERIAL_COLOURS: Readonly<Record<string, number>> = {
  "wall-side": 0xe8e6e1,
  // the plan's glass blue, lightened: seen through at a third of its strength it reads as a tint
  "wall-glass": 0xa9cfe4,
  // anodised aluminium, for the frame a glass partition stands in
  "wall-glass-frame": 0x7d848c,
  "wall-top": 0xd9d6d0,
  "opening-reveal": 0xf4f2ee,
  floor: 0xc9c2b8,
  ceiling: 0xfafafa,
  "floor-side": 0xb5ada2,
  "floor-bottom": 0xb5ada2,
  ground: 0xdedbd5,
  "recipe:table": 0x9c7a55,
  "recipe:chair": 0x3f4a5a,
  "recipe:display": 0x1a1a1a,
  "recipe:video-bar": 0x2b2b2b,
  "recipe:ceiling-speaker": 0xf0f0f0,
  "recipe:ceiling-mic": 0xf0f0f0,
  "recipe:box": 0x8f9aa6,
  "recipe:cylinder": 0x8f9aa6,
  placeholder: 0xffffff,
  failed: 0xff0000,
  item: 0x8f9aa6,
};

/** What a surface's own finish can change about its material; a FinishRef satisfies it. */
export interface FinishLike {
  color: string | null;
  shininess: number | null;
}

/**
 * The material key for a surface that may carry a finish: the base key alone, or
 * `<base>|<colour>|<shininess>` with either part empty.
 *
 * The finish rides in the key rather than beside it because the key is the one thing both consumers already
 * group by: the viewer caches a material per key and the glTF export writes one per key. A wall painted red
 * is then a different material everywhere, with no second lookup that one of them could forget.
 */
export function finishedMaterialKey(base: string, finish: FinishLike | null): string {
  if (!finish || (finish.color === null && finish.shininess === null)) return base;
  return `${base}|${finish.color ?? ""}|${finish.shininess ?? ""}`;
}

interface KeyParts {
  base: string;
  colour: number | null;
  shininess: number | null;
}

function splitKey(key: string): KeyParts {
  const [base = key, colour = "", shininess = ""] = key.split("|");
  const hex = /^#[0-9A-Fa-f]{6}$/.test(colour) ? Number.parseInt(colour.slice(1), 16) : null;
  const shine = shininess === "" ? null : Number(shininess);
  return { base, colour: hex, shininess: shine !== null && Number.isFinite(shine) ? shine : null };
}

/** Recipe keys carry size and shape ("recipe:table:boat:3600x1400x750"); materials go by kind. */
export function materialKeyOf(key: string): string {
  if (key.startsWith("recipe:")) return `recipe:${key.split(":")[1] ?? "box"}`;
  return key;
}

/** Everything a renderer needs to draw a key, in one place so the viewer and the export cannot differ. */
export interface MaterialLook {
  /** sRGB. */
  colour: number;
  roughness: number;
  metalness: number;
  /** 1 is solid; below 1 the surface is seen through and drawn blended. */
  opacity: number;
  /** Takes the environment map, when there is one: glass and its frame. Nothing else does, so the rest of
   *  the scene keeps its flat office look. */
  reflective: boolean;
}

/** How a kind of surface differs from the flat, matt, solid default. */
const LOOKS: Readonly<Record<string, Partial<MaterialLook>>> = {
  "wall-glass": { roughness: 0.05, opacity: 0.3, reflective: true },
  "wall-glass-frame": { roughness: 0.35, metalness: 0.6, reflective: true },
  "recipe:display": { roughness: 0.35 },
};

export function materialLook(key: string): MaterialLook {
  const { base, colour, shininess } = splitKey(key);
  const kind = materialKeyOf(base);
  const look = LOOKS[kind] ?? {};
  return {
    colour: colour ?? MATERIAL_COLOURS[kind] ?? MATERIAL_COLOURS.item ?? 0x8f9aa6,
    // A finish's shininess replaces the kind's roughness: satin or gloss on glass reads as frosted.
    roughness: shininess !== null ? roughnessForShininess(shininess) : (look.roughness ?? 0.85),
    metalness: look.metalness ?? 0,
    opacity: look.opacity ?? 1,
    reflective: look.reflective ?? false,
  };
}

export function materialColour(key: string): number {
  return materialLook(key).colour;
}

/**
 * Roughness from a finish's shininess: 0 is the flat 0.85 every surface has by default, 1 is a hard gloss
 * at 0.15. Linear, because shininess is a person's choice of matt, satin or gloss, not a measurement.
 */
export function roughnessForShininess(shininess: number): number {
  return 0.85 - 0.7 * Math.min(1, Math.max(0, shininess));
}

export function materialRoughness(key: string): number {
  return materialLook(key).roughness;
}
