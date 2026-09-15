// Materials by engine material key (ADR-003 D4). Flat office visuals: standard materials, no tone mapping.
import { materialColour, materialKeyOf, materialRoughness } from "@fpv/engine";
import * as THREE from "three";

export class MaterialCache {
  private readonly cache = new Map<string, THREE.Material>();

  /** Material for a key; recipe keys resolve by kind, unknown keys get the item default. */
  get(key: string): THREE.Material {
    const k = this.normalise(key);
    let m = this.cache.get(k);
    if (!m) {
      const colour = materialColour(k);
      m = new THREE.MeshStandardMaterial({
        color: colour,
        roughness: materialRoughness(k),
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
    return materialKeyOf(key);
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
  }
}
