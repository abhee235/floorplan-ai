// Materials by engine material key (ADR-003 D4). Flat office visuals: standard materials, no tone mapping.
// What a key looks like comes from the engine palette, which the glTF export reads too.
import { type MaterialTexture, materialKeyOf, materialLook } from "@fpv/engine";
import * as THREE from "three";

/** Loads a texture's image by id; the host serves them at /textures/<id> (P3-5). */
export type TextureLoad = (textureId: string) => THREE.Texture | null;

/** In a browser, the host's image; anywhere else (tests, a worker without a document) nothing. */
export function hostTextures(): TextureLoad {
  if (typeof document === "undefined") return () => null;
  const loader = new THREE.TextureLoader();
  return (id) => loader.load(`/textures/${id.split("/").map(encodeURIComponent).join("/")}`);
}

export class MaterialCache {
  private readonly cache = new Map<string, THREE.MeshStandardMaterial>();
  private readonly textures = new Map<string, THREE.Texture | null>();
  private environment: THREE.Texture | null = null;

  constructor(private readonly load: TextureLoad = hostTextures()) {}

  /** Material for a key; recipe keys resolve by kind, unknown keys get the item default. */
  get(key: string): THREE.Material {
    const k = this.normalise(key);
    let m = this.cache.get(k);
    if (!m) {
      const look = materialLook(k);
      const seeThrough = look.opacity < 1;
      const map = look.texture ? this.texture(look.texture) : null;
      m = new THREE.MeshStandardMaterial({
        // white under an image, so it shows its own colours; the plain colour where there is none to show
        color: map ? look.colour : look.plainColour,
        roughness: look.roughness,
        metalness: look.metalness,
        transparent: seeThrough,
        opacity: look.opacity,
        // A surface that is seen through must not hide what is behind it from the depth test.
        depthWrite: !seeThrough,
        envMap: look.reflective ? this.environment : null,
        // ceilings face down: single-sided so they are culled from above and the interior stays visible
        side: THREE.FrontSide,
        map,
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

  /**
   * A texture's image, loaded once and repeated so that one copy covers its size: the engine's UVs are in
   * metres, so a 500 mm carpet tile repeats twice a metre.
   */
  private texture(t: MaterialTexture): THREE.Texture | null {
    const known = this.textures.get(t.id);
    if (known !== undefined) return known;
    const map = this.load(t.id);
    if (map) {
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(1000 / t.widthMm, 1000 / t.heightMm);
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 4;
    }
    this.textures.set(t.id, map);
    return map;
  }

  private normalise(key: string): string {
    return materialKeyOf(key);
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
    for (const t of this.textures.values()) t?.dispose();
    this.textures.clear();
  }
}
