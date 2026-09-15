// Flat colours per material key (ADR-003 D4, ADR-013 D4). One palette for the viewer and the glTF export, so an
// exported scene looks like the one on screen. Colours are sRGB hex.

export const MATERIAL_COLOURS: Readonly<Record<string, number>> = {
  "wall-side": 0xe8e6e1,
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

/** Recipe keys carry size and shape ("recipe:table:boat:3600x1400x750"); materials go by kind. */
export function materialKeyOf(key: string): string {
  if (key.startsWith("recipe:")) return `recipe:${key.split(":")[1] ?? "box"}`;
  return key;
}

export function materialColour(key: string): number {
  return MATERIAL_COLOURS[materialKeyOf(key)] ?? MATERIAL_COLOURS.item ?? 0x8f9aa6;
}

export function materialRoughness(key: string): number {
  return materialKeyOf(key) === "recipe:display" ? 0.35 : 0.85;
}
