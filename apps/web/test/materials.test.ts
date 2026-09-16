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

describe("textured materials (P3-5)", () => {
  it("wears the texture's image in white, repeated so one copy covers its size, loading each image once", () => {
    const loaded: string[] = [];
    const cache = new MaterialCache((id) => {
      loaded.push(id);
      return new THREE.Texture();
    });
    const floor = standard(cache.get("floor|||generated/oak@880x1800"));
    expect(floor.map).not.toBeNull();
    expect(floor.color.getHex()).toBe(0xffffff);
    expect(floor.map?.wrapS).toBe(THREE.RepeatWrapping);
    expect(floor.map?.repeat.x).toBeCloseTo(1000 / 880, 9);
    expect(floor.map?.repeat.y).toBeCloseTo(1000 / 1800, 9);
    expect(floor.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    // a glossier floor in the same wood is another material with the same image
    const glossy = standard(cache.get("floor||0.6|generated/oak@880x1800"));
    expect(glossy).not.toBe(floor);
    expect(glossy.map).toBe(floor.map);
    expect(loaded).toEqual(["generated/oak"]);
    expect(standard(cache.get("floor")).map).toBeNull();
  });

  it("draws the plain surface when there is nowhere to load images from", () => {
    const cache = new MaterialCache(() => null);
    const floor = standard(cache.get("floor|||generated/oak@880x1800"));
    expect(floor.map).toBeNull();
    expect(floor.color.getHex()).toBe(standard(cache.get("floor")).color.getHex());
  });
});
