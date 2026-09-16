// Materials by engine material key (ADR-003 D4). Flat office visuals: standard materials, no tone mapping.
// What a key looks like comes from the engine palette, which the glTF export reads too.
import { materialKeyOf, materialLook } from "@fpv/engine";
import * as THREE from "three";

export class MaterialCache {
  private readonly cache = new Map<string, THREE.MeshStandardMaterial>();
  private environment: THREE.Texture | null = null;

  /** Material for a key; recipe keys resolve by kind, unknown keys get the item default. */
  get(key: string): THREE.Material {
    const k = this.normalise(key);
    let m = this.cache.get(k);
    if (!m) {
      const look = materialLook(k);
      const seeThrough = look.opacity < 1;
      m = new THREE.MeshStandardMaterial({
        color: look.colour,
        roughness: look.roughness,
        metalness: look.metalness,
        transparent: seeThrough,
        opacity: look.opacity,
        // A surface that is seen through must not hide what is behind it from the depth test.
        depthWrite: !seeThrough,
        envMap: look.reflective ? this.environment : null,
        // ceilings face down: single-sided so they are culled from above and the interior stays visible
        side: THREE.FrontSide,
      });
      m.name = k;
      this.cache.set(k, m);
    }
    return m;
  }

  /**
   * The environment reflective materials take: glass and its frames. Applied to the ones already made as
   * well, because the renderer that builds the map exists only after the first walls may have been drawn.
   */
  setEnvironment(texture: THREE.Texture | null): void {
    this.environment = texture;
    for (const [k, m] of this.cache) {
      if (!materialLook(k).reflective) continue;
      m.envMap = texture;
      m.needsUpdate = true;
    }
  }

  private normalise(key: string): string {
    return materialKeyOf(key);
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
  }
}
