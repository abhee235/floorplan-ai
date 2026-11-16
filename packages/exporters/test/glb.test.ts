// PRD P2-5: the boardroom fixture exports as a well-formed glTF binary with one node per entity, grouped by level and
// room, deterministic apart from the export time (ADR-013 D2, D4). tools/test/glb-load.test.ts opens it with three.js.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { derive, Project } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import { projectToGlb } from "../src/index.js";

const DIR = fileURLToPath(new URL("../../../tools/fixtures/boardroom.fpviz/", import.meta.url));
const project = Project.parse(JSON.parse(readFileSync(`${DIR}project.json`, "utf8")));
const sizes = derive.snapshotSizeSource(project);
const base = { sizes, appVersion: "0.0.1", exportedAt: "2026-09-16T12:00:00.000Z" };

interface Gltf {
  asset: { version: string; generator: string; extras: Record<string, unknown> };
  scene: number;
  scenes: { nodes: number[] }[];
  nodes: { name: string; mesh?: number; matrix?: number[]; children?: number[]; extras: { kind: string } }[];
  meshes: {
    name: string;
    primitives: { attributes: Record<string, number>; indices: number; material: number }[];
  }[];
  materials: { name: string; pbrMetallicRoughness: { baseColorFactor: number[]; roughnessFactor: number } }[];
  accessors: {
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }[];
  bufferViews: { buffer: number; byteOffset: number; byteLength: number }[];
  buffers: { byteLength: number }[];
}

/** Parse and check a GLB the way a strict loader would; returns the JSON and the binary chunk. */
function parseGlb(bytes: Uint8Array): { json: Gltf; bin: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(dv.getUint32(0, true)).toBe(0x46546c67);
  expect(dv.getUint32(4, true)).toBe(2);
  expect(dv.getUint32(8, true)).toBe(bytes.byteLength);
  const jsonLength = dv.getUint32(12, true);
  expect(dv.getUint32(16, true)).toBe(0x4e4f534a);
  expect(jsonLength % 4).toBe(0);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Gltf;
  const binAt = 20 + jsonLength;
  const binLength = dv.getUint32(binAt, true);
  expect(dv.getUint32(binAt + 4, true)).toBe(0x004e4942);
  expect(binLength % 4).toBe(0);
  const bin = bytes.subarray(binAt + 8, binAt + 8 + binLength);
  expect(json.buffers).toEqual([{ byteLength: binLength }]);
  const size: Record<number, number> = { 5126: 4, 5125: 4 };
  const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3 };
  for (const view of json.bufferViews)
    expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(binLength);
  for (const [i, a] of json.accessors.entries()) {
    const view = json.bufferViews[a.bufferView];
    expect(view, `accessor ${i}`).toBeDefined();
    expect(a.count * (size[a.componentType] ?? 0) * (components[a.type] ?? 0)).toBe(view?.byteLength);
  }
  for (const mesh of json.meshes)
    for (const prim of mesh.primitives) {
      const pos = json.accessors[prim.attributes.POSITION as number];
      const idx = json.accessors[prim.indices];
      const view = json.bufferViews[idx?.bufferView ?? -1];
      const indices = new Uint32Array(
        bin.slice(view?.byteOffset ?? 0, (view?.byteOffset ?? 0) + (view?.byteLength ?? 0)).buffer,
      );
      expect(Math.max(...indices)).toBeLessThan(pos?.count ?? 0);
      expect(pos?.min).toHaveLength(3);
      expect(json.materials[prim.material]).toBeDefined();
    }
  return { json, bin };
}

describe("glTF binary export (PRD P2-5)", () => {
  const out = projectToGlb(project, base);
  const { json } = parseGlb(out.bytes);

  it("is a valid glTF 2.0 binary whose root is the project", () => {
    expect(json.asset).toMatchObject({ version: "2.0", generator: "floorplan-ai 0.0.1" });
    expect(json.asset.extras).toMatchObject({ units: "metres, y up", draft: false, scope: "project" });
    expect(json.scenes[json.scene]?.nodes).toEqual([0]);
    expect(json.nodes[0]?.extras.kind).toBe("project");
  });

  it("has exactly one node per level, wall, opening, room and item, named by entity id", () => {
    const entityIds = [
      ...project.levels.map((l) => l.id),
      ...project.walls.map((w) => w.id),
      ...project.openings.map((o) => o.id),
      ...project.rooms.map((r) => r.id),
      ...project.items.map((i) => i.id),
    ].sort();
    const names = json.nodes
      .slice(1)
      .filter((n) => n.extras.kind !== "ground")
      .map((n) => n.name)
      .sort();
    expect(names).toEqual(entityIds);
    expect(new Set(names).size).toBe(names.length);
    expect(out.report.skippedItems).toEqual([]);
  });

  it("groups walls under their level, openings under their wall, and items under their room", () => {
    const parentOf = new Map(out.nodes.map((n) => [n.name, n.parent]));
    for (const w of project.walls) expect(parentOf.get(w.id)).toBe(w.levelId);
    for (const o of project.openings) expect(parentOf.get(o.id)).toBe(o.wallId);
    for (const r of project.rooms) expect(parentOf.get(r.id)).toBe(r.levelId);
    for (const i of project.items) expect(parentOf.get(i.id)).toBe(i.roomId ?? i.levelId);
  });

  it("items that share an asset share one mesh, and item nodes carry their placement", () => {
    const itemNodes = json.nodes.filter((n) => n.extras.kind === "item");
    expect(itemNodes.every((n) => n.matrix?.length === 16 && n.mesh !== undefined)).toBe(true);
    const distinctMeshes = new Set(itemNodes.map((n) => n.mesh));
    expect(distinctMeshes.size).toBeLessThan(itemNodes.length);
    expect(out.report.triangles).toBeGreaterThan(100);
  });

  it("P2-6 the ground slab is one node under the lowest level, left out of room scopes and on request", () => {
    expect(out.nodes.filter((n) => n.kind === "ground")).toEqual([
      { name: "ground", kind: "ground", parent: project.levels[0]?.id, mesh: true },
    ]);
    const room = project.rooms[0];
    if (!room) throw new Error("fixture has no room");
    const scoped = projectToGlb(project, { ...base, scope: { kind: "room", id: room.id } });
    expect(scoped.nodes.some((n) => n.kind === "ground")).toBe(false);
    expect(projectToGlb(project, { ...base, ground: false }).nodes.some((n) => n.kind === "ground")).toBe(
      false,
    );
  });

  it("the node list matches the golden file", () => {
    const golden = `${DIR}glb-nodes.json`;
    const text = `${JSON.stringify(out.nodes, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN) writeFileSync(golden, text);
    expect(text).toBe(readFileSync(golden, "utf8").replaceAll("\r\n", "\n"));
  });

  it("is byte-identical for the same inputs and differs only in the export time otherwise", () => {
    expect(projectToGlb(project, base).bytes).toEqual(out.bytes);
    const later = parseGlb(
      projectToGlb(project, { ...base, exportedAt: "2026-09-17T08:00:00.000Z" }).bytes,
    ).json;
    const strip = (g: Gltf) => ({
      ...g,
      asset: { ...g.asset, extras: { ...g.asset.extras, exportedAt: null } },
    });
    expect(strip(later)).toEqual(strip(json));
  });

  it("a room scope keeps the room, its items and its bounding walls; a draft is marked", () => {
    const room = project.rooms[0];
    if (!room) throw new Error("fixture has no room");
    const scoped = projectToGlb(project, { ...base, scope: { kind: "room", id: room.id }, draft: true });
    const parsed = parseGlb(scoped.bytes).json;
    expect(parsed.asset.extras).toMatchObject({ draft: true, scope: `room:${room.id}` });
    expect(parsed.nodes[0]?.name.endsWith("(DRAFT)")).toBe(true);
    const walls = scoped.nodes
      .filter((n) => n.kind === "wall")
      .map((n) => n.name)
      .sort();
    expect(walls).toEqual([...room.boundingWallIds].sort());
    expect(scoped.nodes.filter((n) => n.kind === "item")).toHaveLength(
      project.items.filter((i) => i.roomId === room.id).length,
    );
    expect(() => projectToGlb(project, { ...base, scope: { kind: "room", id: "room_nope" } })).toThrow(
      "does not exist",
    );
  });

  it("W-106 a painted wall side exports as its own material, in the colour the viewer shows", () => {
    const wall = project.walls[0];
    if (!wall) throw new Error("fixture has no wall");
    const painted = {
      ...project,
      walls: project.walls.map((w) =>
        w.id === wall.id
          ? {
              ...w,
              finishes: {
                ...w.finishes,
                left: {
                  color: "#FF0000",
                  textureId: null,
                  placement: null,
                  mirrorForLeftSide: false,
                  shininess: 1,
                },
              },
            }
          : w,
      ),
    };
    const materials = parseGlb(projectToGlb(painted, base).bytes).json.materials;
    const red = materials.find((m) => m.name === "wall-side|#FF0000|1");
    expect(red?.pbrMetallicRoughness.baseColorFactor).toEqual([1, 0, 0, 1]);
    expect(red?.pbrMetallicRoughness.roughnessFactor).toBeCloseTo(0.15, 6);
    // the plain wall material is still there for every other side
    expect(materials.some((m) => m.name === "wall-side")).toBe(true);
  });

  it("P3-5 exports catalogue chairs in parts, and a chair with its own fabric as its own mesh", () => {
    const chairs = project.items.filter(
      (i) => i.ref.kind === "product" && i.ref.productId === "herman-miller-aeron-b",
    );
    const first = chairs[0];
    if (!first) throw new Error("fixture has no chairs");
    const recovered = {
      ...project,
      items: project.items.map((i) =>
        i.id === first.id
          ? {
              ...i,
              materials: {
                fabric: {
                  color: "#AA3333",
                  textureId: null,
                  placement: null,
                  mirrorForLeftSide: false,
                  shininess: null,
                },
              },
            }
          : i,
      ),
    };
    const gltf = parseGlb(projectToGlb(recovered, base).bytes).json;
    const meshOf = (id: string) => gltf.meshes[gltf.nodes.find((n) => n.name === id)?.mesh ?? -1];
    const materialNames = (id: string) => meshOf(id)?.primitives.map((p) => gltf.materials[p.material]?.name);
    expect(materialNames(first.id)).toEqual(["chair/fabric|#AA3333|", "chair/frame"]);
    const others = chairs.slice(1).map((c) => meshOf(c.id));
    expect(new Set(others).size).toBe(1);
    expect(others[0]).not.toBe(meshOf(first.id));
    expect(materialNames((chairs[1] as { id: string }).id)).toEqual(["chair/fabric", "chair/frame"]);
  });

  it("exports glass as a blended, see-through material", () => {
    const wall = project.walls[0];
    if (!wall) throw new Error("fixture has no wall");
    const glazed = {
      ...project,
      walls: project.walls.map((w) => (w.id === wall.id ? { ...w, kind: "glass" as const } : w)),
    };
    const materials = parseGlb(projectToGlb(glazed, base).bytes).json
      .materials as (Gltf["materials"][number] & {
      alphaMode?: string;
    })[];
    const glass = materials.find((m) => m.name === "wall-glass");
    expect(glass?.alphaMode).toBe("BLEND");
    expect(glass?.pbrMetallicRoughness.baseColorFactor[3]).toBe(0.3);
    // solid materials stay opaque, with no alpha mode at all
    expect(materials.find((m) => m.name === "wall-side")?.alphaMode).toBeUndefined();
  });
});
