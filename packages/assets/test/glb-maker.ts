// Small binary glTF files for tests: boxes, each its own mesh under its own node, with the node's
// transform and the box's material as given. Shared with the host's and the viewer's tests.
import { type GltfDocument, writeGlb } from "../src/gltf.js";

export interface BoxSpec {
  min: [number, number, number];
  max: [number, number, number];
  /** The material's name; null gives a material with no name, undefined no material at all. */
  material?: string | null;
  node?: { translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[] };
}

export interface GlbOptions {
  extensionsRequired?: string[];
  /** An image that points at a file outside the model. */
  externalImage?: string;
  /** Leave the points out of the file: only the accessor's declared bounds say where the box is. */
  boundsOnly?: boolean;
  /** Put the data in a base64 data URI instead of the binary chunk. */
  dataUri?: boolean;
}

/** The box's eight corners and its twelve triangles. */
function box(min: [number, number, number], max: [number, number, number]) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0,
    y0,
    z0,
    x1,
    y0,
    z0,
    x1,
    y1,
    z0,
    x0,
    y1,
    z0,
    x0,
    y0,
    z1,
    x1,
    y0,
    z1,
    x1,
    y1,
    z1,
    x0,
    y1,
    z1,
  ]);
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6,
    5,
  ]);
  return { positions, indices };
}

export function boxGlb(boxes: BoxSpec[], options: GlbOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  let length = 0;
  const add = (bytes: Uint8Array) => {
    const at = length;
    parts.push(bytes);
    length += bytes.length;
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      length += pad;
    }
    return at;
  };
  const doc: GltfDocument = {
    asset: { version: "2.0", generator: "glb-maker" },
    scene: 0,
    scenes: [{ nodes: boxes.map((_, i) => i) }],
    nodes: [],
    meshes: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
    materials: [],
  };
  const materials = new Map<string | null, number>();
  boxes.forEach((b, i) => {
    const { positions, indices } = box(b.min, b.max);
    const views = doc.bufferViews ?? [];
    const accessors = doc.accessors ?? [];
    const position = accessors.length;
    accessors.push({
      ...(options.boundsOnly ? {} : { bufferView: views.length }),
      componentType: 5126,
      count: 8,
      type: "VEC3",
      min: [...b.min],
      max: [...b.max],
    });
    if (!options.boundsOnly) {
      const bytes = new Uint8Array(positions.buffer);
      views.push({ buffer: 0, byteOffset: add(bytes), byteLength: bytes.length });
    }
    const index = accessors.length;
    const indexBytes = new Uint8Array(indices.buffer);
    views.push({ buffer: 0, byteOffset: add(indexBytes), byteLength: indexBytes.length });
    accessors.push({
      bufferView: views.length - 1,
      componentType: 5123,
      count: indices.length,
      type: "SCALAR",
    });
    let material: number | undefined;
    if (b.material !== undefined) {
      const known = materials.get(b.material);
      if (known !== undefined) material = known;
      else {
        material = doc.materials?.length ?? 0;
        doc.materials?.push(b.material === null ? {} : { name: b.material });
        materials.set(b.material, material);
      }
    }
    doc.meshes?.push({
      primitives: [
        {
          attributes: { POSITION: position },
          indices: index,
          ...(material !== undefined ? { material } : {}),
        },
      ],
    });
    doc.nodes?.push({ name: `box-${i}`, mesh: i, ...(b.node ?? {}) });
  });
  const bin = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    bin.set(p, at);
    at += p.length;
  }
  if (options.extensionsRequired) {
    doc.extensionsRequired = options.extensionsRequired;
    doc.extensionsUsed = options.extensionsRequired;
  }
  if (options.externalImage) doc.images = [{ uri: options.externalImage }];
  if (options.dataUri) {
    doc.buffers = [{ byteLength: length, uri: `data:application/octet-stream;base64,${base64(bin)}` }];
    return writeGlb(doc, null);
  }
  doc.buffers = [{ byteLength: length }];
  return writeGlb(doc, bin);
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
