// glTF binary scene export (ADR-013 D4, PRD P2-5). The engine builds the same geometry the viewer shows; this writes it
// as one .glb: a root node for the project, a node per level, under it a node per wall (with its openings as child nodes)
// and per room (with the items in that room as child nodes), every node named by its entity id. Items that share an
// asset share one mesh. Positions are metres with y up, which is glTF's own frame. Pure and deterministic: the same
// project, sizes and options give the same bytes, and only asset.extras.exportedAt changes between exports.
import {
  type AssetRegistry,
  buildItems,
  buildRecipe,
  buildRooms,
  buildWalls,
  type GeometryPart,
  materialColour,
  materialKeyOf,
  materialRoughness,
  noAssets,
} from "@fpv/engine";
import { derive, type Project } from "@fpv/ir";

export type GlbScope = { kind: "project" } | { kind: "level"; id: string } | { kind: "room"; id: string };

export interface GlbOptions {
  sizes: derive.SizeSource;
  assets?: AssetRegistry;
  appVersion: string;
  exportedAt: string;
  /** Marks the file as exported over validation errors (ADR-013 D2). */
  draft?: boolean;
  scope?: GlbScope;
}

export type GlbNodeKind = "project" | "level" | "wall" | "opening" | "room" | "item";

export interface GlbNode {
  name: string;
  kind: GlbNodeKind;
  parent: string | null;
  mesh: boolean;
}

export interface GlbReport {
  nodes: number;
  meshes: number;
  primitives: number;
  triangles: number;
  materials: number;
  /** Items left out: no size, or hidden. */
  skippedItems: string[];
}

export interface GlbExport {
  bytes: Uint8Array;
  /** The node tree in file order (depth first), for tests and reports. */
  nodes: GlbNode[];
  report: GlbReport;
}

export class GlbExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlbExportError";
  }
}

type Json = Record<string, unknown>;

const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const TRIANGLES = 4;

const srgbToLinear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

interface TreeNode {
  name: string;
  kind: GlbNodeKind;
  mesh: number | null;
  matrix: number[] | null;
  extras: Json;
  children: TreeNode[];
}

class GltfBuilder {
  private readonly bin: Uint8Array[] = [];
  private binLength = 0;
  readonly bufferViews: Json[] = [];
  readonly accessors: Json[] = [];
  readonly materials: Json[] = [];
  readonly meshes: Json[] = [];
  primitives = 0;
  triangles = 0;
  private readonly materialIndex = new Map<string, number>();

  private view(data: Float32Array | Uint32Array, target: number): number {
    const pad = (4 - (this.binLength % 4)) % 4;
    if (pad) {
      this.bin.push(new Uint8Array(pad));
      this.binLength += pad;
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    this.bin.push(bytes);
    const byteOffset = this.binLength;
    this.binLength += bytes.byteLength;
    this.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength, target });
    return this.bufferViews.length - 1;
  }

  private accessor(
    view: number,
    componentType: number,
    count: number,
    type: string,
    extra: Json = {},
  ): number {
    this.accessors.push({ bufferView: view, componentType, count, type, ...extra });
    return this.accessors.length - 1;
  }

  material(key: string): number {
    const norm = materialKeyOf(key);
    const known = this.materialIndex.get(norm);
    if (known !== undefined) return known;
    const c = materialColour(norm);
    this.materials.push({
      name: norm,
      pbrMetallicRoughness: {
        baseColorFactor: [
          round6(srgbToLinear((c >> 16) & 255)),
          round6(srgbToLinear((c >> 8) & 255)),
          round6(srgbToLinear(c & 255)),
          1,
        ],
        metallicFactor: 0,
        roughnessFactor: materialRoughness(norm),
      },
    });
    this.materialIndex.set(norm, this.materials.length - 1);
    return this.materials.length - 1;
  }

  /** One mesh with a primitive per part; null when no part has triangles. */
  mesh(name: string, parts: readonly GeometryPart[]): number | null {
    const primitives: Json[] = [];
    for (const part of parts) {
      const vertexCount = part.positions.length / 3;
      if (vertexCount === 0 || part.indices.length === 0) continue;
      const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
      const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
      for (let i = 0; i < part.positions.length; i += 1) {
        const v = part.positions[i] as number;
        const axis = i % 3;
        if (v < (min[axis] as number)) min[axis] = v;
        if (v > (max[axis] as number)) max[axis] = v;
      }
      const attributes: Json = {
        POSITION: this.accessor(this.view(part.positions, ARRAY_BUFFER), FLOAT, vertexCount, "VEC3", {
          min,
          max,
        }),
      };
      if (part.normals.length === part.positions.length)
        attributes.NORMAL = this.accessor(this.view(part.normals, ARRAY_BUFFER), FLOAT, vertexCount, "VEC3");
      if (part.uvs.length === vertexCount * 2)
        attributes.TEXCOORD_0 = this.accessor(this.view(part.uvs, ARRAY_BUFFER), FLOAT, vertexCount, "VEC2");
      primitives.push({
        attributes,
        indices: this.accessor(
          this.view(part.indices, ELEMENT_ARRAY_BUFFER),
          UNSIGNED_INT,
          part.indices.length,
          "SCALAR",
        ),
        material: this.material(part.materialKey),
        mode: TRIANGLES,
        extras: { part: part.part },
      });
      this.primitives += 1;
      this.triangles += part.indices.length / 3;
    }
    if (primitives.length === 0) return null;
    this.meshes.push({ name, primitives });
    return this.meshes.length - 1;
  }

  glb(json: Json): Uint8Array {
    const bin = new Uint8Array((this.binLength + 3) & ~3);
    let off = 0;
    for (const chunk of this.bin) {
      bin.set(chunk, off);
      off += chunk.byteLength;
    }
    const withBuffer = this.binLength > 0 ? { ...json, buffers: [{ byteLength: bin.byteLength }] } : json;
    const text = new TextEncoder().encode(JSON.stringify(withBuffer));
    const jsonChunk = new Uint8Array((text.byteLength + 3) & ~3).fill(0x20);
    jsonChunk.set(text);
    const total = 12 + 8 + jsonChunk.byteLength + (this.binLength > 0 ? 8 + bin.byteLength : 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); // "glTF"
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonChunk.byteLength, true);
    dv.setUint32(16, 0x4e4f534a, true); // "JSON"
    out.set(jsonChunk, 20);
    if (this.binLength > 0) {
      const at = 20 + jsonChunk.byteLength;
      dv.setUint32(at, bin.byteLength, true);
      dv.setUint32(at + 4, 0x004e4942, true); // "BIN\0"
      out.set(bin, at + 8);
    }
    return out;
  }
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function groupByEntity(parts: readonly GeometryPart[]): Map<string, GeometryPart[]> {
  const out = new Map<string, GeometryPart[]>();
  for (const p of parts) out.set(p.entityId, [...(out.get(p.entityId) ?? []), p]);
  return out;
}

export function projectToGlb(project: Project, options: GlbOptions): GlbExport {
  const scope = options.scope ?? { kind: "project" };
  const b = new GltfBuilder();
  const skippedItems: string[] = [];
  const levels = [...project.levels].sort((x, y) => x.elevation - y.elevation || (x.id < y.id ? -1 : 1));
  const lowest = levels[0]?.id;
  const highest = levels[levels.length - 1]?.id;
  const room = scope.kind === "room" ? project.rooms.find((r) => r.id === scope.id) : undefined;
  if (scope.kind === "room" && !room) throw new GlbExportError(`room "${scope.id}" does not exist`);
  if (scope.kind === "level" && !levels.some((l) => l.id === scope.id))
    throw new GlbExportError(`level "${scope.id}" does not exist`);
  const levelIds = new Set(
    scope.kind === "project"
      ? levels.map((l) => l.id)
      : scope.kind === "level"
        ? [scope.id]
        : [(room as { levelId: string }).levelId],
  );
  const assetMeshes = new Map<string, number | null>();

  const root: TreeNode = {
    name: `${project.meta.name}${options.draft ? " (DRAFT)" : ""}`,
    kind: "project",
    mesh: null,
    matrix: null,
    extras: { projectName: project.meta.name, draft: options.draft ?? false },
    children: [],
  };

  for (const level of levels) {
    if (!levelIds.has(level.id)) continue;
    const levelNode: TreeNode = {
      name: level.id,
      kind: "level",
      mesh: null,
      matrix: null,
      extras: { name: level.name, elevationMm: level.elevation, heightMm: level.height },
      children: [],
    };
    const levelWalls = project.walls.filter((w) => w.levelId === level.id);
    const walls = (room ? levelWalls.filter((w) => room.boundingWallIds.includes(w.id)) : levelWalls).sort(
      byId,
    );
    const wallParts = groupByEntity(
      buildWalls(levelWalls, project.openings, {
        level,
        isLowest: level.id === lowest,
        isHighest: level.id === highest,
      }),
    );
    for (const w of walls) {
      const wallNode: TreeNode = {
        name: w.id,
        kind: "wall",
        mesh: b.mesh(w.id, wallParts.get(w.id) ?? []),
        matrix: null,
        extras: { wallKind: w.kind, thicknessMm: w.thickness },
        children: [],
      };
      for (const o of project.openings.filter((x) => x.wallId === w.id).sort(byId))
        wallNode.children.push({
          name: o.id,
          kind: "opening",
          mesh: b.mesh(o.id, wallParts.get(o.id) ?? []),
          matrix: null,
          extras: { openingKind: o.kind, widthMm: o.width, heightMm: o.height, sillMm: o.sill },
          children: [],
        });
      levelNode.children.push(wallNode);
    }

    const levelRooms = project.rooms.filter((r) => r.levelId === level.id);
    const rooms = (room ? [room] : levelRooms).sort(byId);
    const roomParts = groupByEntity(buildRooms(levelRooms, { level, isLowest: level.id === lowest }));
    const levelItems = project.items.filter((i) => i.levelId === level.id);
    const items = (room ? levelItems.filter((i) => i.roomId === room.id) : levelItems).sort(byId);
    const instances = new Map(
      buildItems(items, { level, sizes: options.sizes, assets: options.assets ?? noAssets }).map((i) => [
        i.entityId,
        i,
      ]),
    );
    const itemNodes = new Map<string, TreeNode>();
    for (const it of items) {
      const inst = instances.get(it.id);
      const size = derive.itemSize(it, options.sizes);
      if (!inst || !size || !inst.visible) {
        skippedItems.push(it.id);
        continue;
      }
      let mesh = assetMeshes.get(inst.assetKey);
      if (mesh === undefined) {
        const part =
          it.ref.kind === "recipe"
            ? buildRecipe(it.ref.recipe)
            : { ...buildRecipe({ kind: "box", size, label: it.ref.productId }), materialKey: "item" };
        mesh = b.mesh(inst.assetKey, [part]);
        assetMeshes.set(inst.assetKey, mesh);
      }
      itemNodes.set(it.id, {
        name: it.id,
        kind: "item",
        mesh,
        matrix: inst.matrix.map(round6),
        extras: {
          assetKey: inst.assetKey,
          ...(it.ref.kind === "recipe" ? { recipe: it.ref.recipe.kind } : { productId: it.ref.productId }),
          tags: it.tags,
        },
        children: [],
      });
    }
    for (const r of rooms) {
      levelNode.children.push({
        name: r.id,
        kind: "room",
        mesh: b.mesh(r.id, roomParts.get(r.id) ?? []),
        matrix: null,
        extras: {
          name: r.name,
          purpose: r.purpose,
          capacity: r.capacity,
          areaM2: round6(derive.roomArea(r) / 1e6),
        },
        children: items
          .filter((i) => i.roomId === r.id && itemNodes.has(i.id))
          .map((i) => itemNodes.get(i.id) as TreeNode),
      });
    }
    for (const it of items)
      if (itemNodes.has(it.id) && !rooms.some((r) => r.id === it.roomId))
        levelNode.children.push(itemNodes.get(it.id) as TreeNode);
    root.children.push(levelNode);
  }

  // depth-first order gives each node its index; children refer to later indices
  const order: { node: TreeNode; parent: TreeNode | null }[] = [];
  const visit = (node: TreeNode, parent: TreeNode | null) => {
    order.push({ node, parent });
    for (const c of node.children) visit(c, node);
  };
  visit(root, null);
  const index = new Map(order.map((o, i) => [o.node, i]));
  const nodes = order.map(({ node }) => ({
    name: node.name,
    ...(node.mesh !== null ? { mesh: node.mesh } : {}),
    ...(node.matrix ? { matrix: node.matrix } : {}),
    ...(node.children.length ? { children: node.children.map((c) => index.get(c) as number) } : {}),
    extras: { kind: node.kind, ...node.extras },
  }));

  const json: Json = {
    asset: {
      version: "2.0",
      generator: `floorplan-viz ${options.appVersion}`,
      extras: {
        exportedAt: options.exportedAt,
        draft: options.draft ?? false,
        units: "metres, y up",
        scope: scope.kind === "project" ? "project" : `${scope.kind}:${scope.id}`,
      },
    },
    scene: 0,
    scenes: [{ name: project.meta.name, nodes: [0] }],
    nodes,
    ...(b.meshes.length ? { meshes: b.meshes } : {}),
    ...(b.materials.length ? { materials: b.materials } : {}),
    ...(b.accessors.length ? { accessors: b.accessors } : {}),
    ...(b.bufferViews.length ? { bufferViews: b.bufferViews } : {}),
  };
  return {
    bytes: b.glb(json),
    nodes: order.map(({ node, parent }) => ({
      name: node.name,
      kind: node.kind,
      parent: parent ? parent.name : null,
      mesh: node.mesh !== null,
    })),
    report: {
      nodes: nodes.length,
      meshes: b.meshes.length,
      primitives: b.primitives,
      triangles: b.triangles,
      materials: b.materials.length,
      skippedItems,
    },
  };
}
