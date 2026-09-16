import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { MaterialCache } from "../src/viewer/materials.js";

const standard = (m: THREE.Material) => m as THREE.MeshStandardMaterial;

describe("viewer materials (ADR-003 D4)", () => {
  it("draws glass blended and without writing depth, so what is behind it still shows", () => {
    const cache = new MaterialCache();
    const glass = standard(cache.get("wall-glass"));
    expect(glass.transparent).toBe(true);
    expect(glass.opacity).toBe(0.3);
    expect(glass.depthWrite).toBe(false);
    const wall = standard(cache.get("wall-side"));
    expect(wall.transparent).toBe(false);
    expect(wall.depthWrite).toBe(true);
  });

  it("gives the environment to glass and its frame only, including materials made before it existed", () => {
    const cache = new MaterialCache();
    const early = standard(cache.get("wall-glass"));
    const wall = standard(cache.get("wall-side"));
    const env = new THREE.Texture();
    cache.setEnvironment(env);
    expect(early.envMap).toBe(env);
    expect(standard(cache.get("wall-glass-frame")).envMap).toBe(env);
    expect(standard(cache.get("wall-glass|#88CC88|")).envMap).toBe(env);
    expect(wall.envMap).toBeNull();
  });
});
