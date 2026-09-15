// Materials by engine material key (ADR-003 D4). Flat office visuals: standard materials, no tone mapping.
import * as THREE from "three";

const COLOURS: Record<string, number> = {
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

export class MaterialCache {
  private readonly cache = new Map<string, THREE.Material>();

  /** Material for a key; recipe keys resolve by kind, unknown keys get the item default. */
  get(key: string): THREE.Material {
    const k = this.normalise(key);
    let m = this.cache.get(k);
    if (!m) {
      const colour = COLOURS[k] ?? COLOURS.item ?? 0x8f9aa6;
      m = new THREE.MeshStandardMaterial({
        color: colour,
        roughness: k === "recipe:display" ? 0.35 : 0.85,
        metalness: 0,
        // ceilings face down: single-sided so they are culled from above and the interior stays visible
        side: THREE.FrontSide,
      });
      m.name = k;
      this.cache.set(k, m);
    }
    return m;
  }

  private normalise(key: string): string {
    if (key.startsWith("recipe:")) {
      const kind = key.split(":")[1] ?? "box";
      return `recipe:${kind}`;
    }
    return key;
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
  }
}
