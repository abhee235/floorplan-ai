// PRD P2-5 acceptance: the exported GLB opens in a standard glTF loader (three.js GLTFLoader) with one node per
// entity, and the loaded scene sits where the viewer puts it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { projectToGlb } from "@fpv/exporters";
import { derive, Project } from "@fpv/ir";
import * as THREE from "three";
import { type GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../../tools/fixtures/boardroom.fpviz/", import.meta.url));
const project = Project.parse(JSON.parse(readFileSync(`${DIR}project.json`, "utf8")));

function load(bytes: Uint8Array): Promise<GLTF> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, "", resolve, reject));
}

describe("GLB opens in three.js GLTFLoader (PRD P2-5)", () => {
  it("loads with one named object per entity, meshes on walls, rooms and items, and a scene in metres", async () => {
    const { bytes } = projectToGlb(project, {
      sizes: derive.snapshotSizeSource(project),
      appVersion: "0.0.1",
      exportedAt: "2026-09-16T12:00:00.000Z",
    });
    const gltf = await load(bytes);
    const named = (id: string) => gltf.scene.getObjectByName(id);
    for (const e of [
      ...project.levels,
      ...project.walls,
      ...project.openings,
      ...project.rooms,
      ...project.items,
    ])
      expect(named(e.id), e.id).toBeDefined();
    for (const w of project.walls) expect(named(w.id)?.parent?.name).toBe(w.levelId);
    for (const i of project.items) expect(named(i.id)?.parent?.name).toBe(i.roomId ?? i.levelId);

    let meshes = 0;
    gltf.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes += 1;
    });
    expect(meshes).toBeGreaterThan(project.walls.length + project.items.length);

    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    // the boardroom with its 10 m ground margin is metres across and a storey tall, not millimetres
    expect(size.x).toBeGreaterThan(3);
    expect(size.x).toBeLessThan(40);
    expect(named("ground")?.parent?.name).toBe(project.levels[0]?.id);
    expect(size.y).toBeGreaterThan(2);
    expect(size.y).toBeLessThan(6);
    expect(gltf.parser.json.asset.generator).toBe("floorplan-viz 0.0.1");
  });
});
