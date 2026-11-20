// glTF models (ADR-010 D3, D10; PRD P3-8): read a binary glTF, measure what it holds, and normalise it so
// the viewer scales it onto a product like any catalog model. Normalising adds one root node that turns the
// model, scales it to metres, stands it on y = 0 and centres its footprint on the origin; nothing else in
// the file changes. Its front is toward +z, glTF's own convention and where a recipe's front is.
// Pure: no file system and no three.js, so the host, the tools and the tests share it.

export class GltfError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = "GltfError";
  }
}

type Json = Record<string, unknown>;

export interface GltfNode extends Json {
  name?: string;
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

export interface GltfPrimitive extends Json {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
  material?: number;
}

export interface GltfAccessor extends Json {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  sparse?: unknown;
}

export interface GltfBufferView extends Json {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  extensions?: Json;
}

export interface GltfDocument extends Json {
  asset: Json & { version?: string };
  scene?: number;
  scenes?: (Json & { nodes?: number[] })[];
  nodes?: GltfNode[];
  meshes?: (Json & { primitives: GltfPrimitive[] })[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: (Json & { byteLength: number; uri?: string })[];
  materials?: (Json & { name?: string })[];
  images?: (Json & { uri?: string })[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

/** Extensions a file may require that the viewer's loader handles without anything more (three.js r186). */
const SUPPORTED_REQUIRED: ReadonlySet<string> = new Set([
  "KHR_mesh_quantization",
  "KHR_texture_transform",
  "KHR_materials_unlit",
  "KHR_materials_emissive_strength",
  "KHR_materials_clearcoat",
  "KHR_materials_ior",
  "KHR_materials_specular",
  "KHR_materials_transmission",
  "KHR_materials_volume",
  "KHR_materials_sheen",
  "KHR_materials_iridescence",
  "KHR_materials_anisotropy",
  "KHR_materials_dispersion",
  "KHR_lights_punctual",
  "EXT_meshopt_compression",
  "EXT_mesh_gpu_instancing",
  "EXT_texture_webp",
  "EXT_texture_avif",
]);

/** Read a binary glTF: its JSON and its binary chunk. Throws GltfError for anything else. */
export function readGlb(bytes: Uint8Array): { json: GltfDocument; bin: Uint8Array | null } {
  // past white space and a byte order mark, a text .gltf starts with "{"
  const first = bytes.find((b) => ![0x20, 0x0a, 0x0d, 0x09, 0xef, 0xbb, 0xbf].includes(b));
  if (first === 0x7b)
    throw new GltfError(
      "model.gltf-text",
      "this is a .gltf text file, which keeps its data in other files",
      "export the model as one .glb, or choose the .gltf together with its files in the editor",
    );
  const notGlb = new GltfError(
    "model.not-glb",
    "the file is not a binary glTF model",
    "export the model as glTF binary (.glb)",
  );
  if (bytes.length < 20) throw notGlb;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw notGlb;
  const version = view.getUint32(4, true);
  if (version !== 2)
    throw new GltfError(
      "model.version",
      `the file is glTF version ${version}; only glTF 2.0 is read`,
      "export it again as glTF 2.0",
    );
  const length = view.getUint32(8, true);
  if (length > bytes.length)
    throw new GltfError("model.corrupt", "the file is cut short", "download or export it again");
  let json: GltfDocument | null = null;
  let bin: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= length) {
    const chunkLength = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > length)
      throw new GltfError("model.corrupt", "a part of the file runs past its end", "export it again");
    if (type === JSON_CHUNK && !json) json = parseJson(bytes.subarray(start, end));
    else if (type === BIN_CHUNK && !bin) bin = bytes.subarray(start, end);
    offset = end;
  }
  if (!json) throw new GltfError("model.corrupt", "the file has no glTF description", "export it again");
  return { json, bin };
}

function parseJson(bytes: Uint8Array): GltfDocument {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GltfError("model.corrupt", "the file's glTF description is not valid JSON", "export it again");
  }
  const asset = (doc as { asset?: { version?: unknown } } | null)?.asset;
  if (!doc || typeof doc !== "object" || !asset || typeof asset.version !== "string")
    throw new GltfError(
      "model.corrupt",
      "the file's glTF description has no asset version",
      "export it again",
    );
  if (!asset.version.startsWith("2."))
    throw new GltfError(
      "model.version",
      `the file is glTF version ${asset.version}; only glTF 2.0 is read`,
      "export it again as glTF 2.0",
    );
  return doc as GltfDocument;
}

/** A binary glTF from a description and its binary chunk, each padded to four bytes as the format asks. */
export function writeGlb(json: GltfDocument, bin: Uint8Array | null): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = text.length + ((4 - (text.length % 4)) % 4);
  const binLength = bin ? bin.length + ((4 - (bin.length % 4)) % 4) : 0;
  const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  if (bin) {
    const at = 20 + jsonLength;
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, BIN_CHUNK, true);
    out.set(bin, at + 8);
  }
  return out;
}

/**
 * What would stop the viewer drawing the file as it is: data in other files, compression it has no decoder
 * for, or nothing to draw. Throws the first.
 */
export function checkGltf(doc: GltfDocument): void {
  for (const name of doc.extensionsRequired ?? []) {
    if (SUPPORTED_REQUIRED.has(name)) continue;
    if (name === "KHR_draco_mesh_compression")
      throw new GltfError(
        "model.draco",
        "the model is compressed with Draco, which this app does not decode",
        "export it again without Draco compression",
      );
    if (name === "KHR_texture_basisu")
      throw new GltfError(
        "model.extension",
        "the model's textures are KTX2, which this app does not decode",
        "export it again with PNG or JPEG textures",
      );
    throw new GltfError(
      "model.extension",
      `the model needs the glTF extension ${name}, which this app does not support`,
      "export it again without that extension",
    );
  }
  const outside = [...(doc.buffers ?? []), ...(doc.images ?? [])].find(
    (b) => typeof b.uri === "string" && !b.uri.startsWith("data:"),
  );
  if (outside)
    throw new GltfError(
      "model.external",
      `the model points at a file outside it (${String(outside.uri)})`,
      "export it as one .glb with its textures inside, or choose the .gltf with its files in the editor",
    );
  if (!doc.scenes?.length || !doc.meshes?.length)
    throw new GltfError("model.empty", "the model has nothing to draw", "export the scene with its meshes");
}

// ---- matrices: column-major 4x4, glTF's layout ------------------------------------------------------

type M4 = number[];

function identity(): M4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function mul(a: M4, b: M4): M4 {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col += 1)
    for (let row = 0; row < 4; row += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1) s += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
      out[col * 4 + row] = s;
    }
  return out;
}

function nodeMatrix(node: GltfNode): M4 {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return [...node.matrix];
  const [tx = 0, ty = 0, tz = 0] = node.translation ?? [];
  const [x = 0, y = 0, z = 0, w = 1] = node.rotation ?? [];
  const [sx = 1, sy = 1, sz = 1] = node.scale ?? [];
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  return [
    (1 - 2 * (yy + zz)) * sx,
    2 * (x * y + w * z) * sx,
    2 * (x * z - w * y) * sx,
    0,
    2 * (x * y - w * z) * sy,
    (1 - 2 * (xx + zz)) * sy,
    2 * (y * z + w * x) * sy,
    0,
    2 * (x * z + w * y) * sz,
    2 * (y * z - w * x) * sz,
    (1 - 2 * (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function apply(m: M4, x: number, y: number, z: number): [number, number, number] {
  return [
    (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
    (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
    (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
  ];
}

// cos and sin of a quarter turn, exactly: Math.cos(Math.PI / 2) is 6e-17, which would ride into the file
const QUARTER_COS = [1, 0, -1, 0] as const;
const QUARTER_SIN = [0, 1, 0, -1] as const;
const quarter = (turns: number) => ((Math.round(turns) % 4) + 4) % 4;

/** About +y, counter-clockwise seen from above, as a plan rotation is (the engine's rotationY). */
function turnMatrix(turns: number): M4 {
  const q = quarter(turns);
  const c = QUARTER_COS[q] as number;
  const s = QUARTER_SIN[q] as number;
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

/**
 * About +x, top toward the viewer: one step stands up a model that was made with z up and so arrives lying
 * on its back, its top facing +z and its front facing down.
 */
function tipMatrix(turns: number): M4 {
  const q = quarter(turns);
  const c = QUARTER_COS[q] as number;
  const s = -(QUARTER_SIN[q] as number);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

// ---- reading positions -------------------------------------------------------------------------------

const COMPONENT_BYTES: Readonly<Record<number, number>> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

function component(view: DataView, at: number, type: number, normalized: boolean): number {
  switch (type) {
    case 5126:
      return view.getFloat32(at, true);
    case 5120: {
      const v = view.getInt8(at);
      return normalized ? Math.max(v / 127, -1) : v;
    }
    case 5121: {
      const v = view.getUint8(at);
      return normalized ? v / 255 : v;
    }
    case 5122: {
      const v = view.getInt16(at, true);
      return normalized ? Math.max(v / 32767, -1) : v;
    }
    case 5123: {
      const v = view.getUint16(at, true);
      return normalized ? v / 65535 : v;
    }
    default:
      return view.getUint32(at, true);
  }
}

function decodeDataUri(uri: string): Uint8Array | null {
  const comma = uri.indexOf(",");
  if (comma < 0 || !uri.slice(0, comma).endsWith(";base64")) return null;
  try {
    const binary = atob(uri.slice(comma + 1));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The bytes of each buffer this file holds itself: the binary chunk, and any written into a data URI. */
function bufferBytes(doc: GltfDocument, bin: Uint8Array | null): (Uint8Array | null)[] {
  return (doc.buffers ?? []).map((b, i) => {
    if (typeof b.uri === "string") return b.uri.startsWith("data:") ? decodeDataUri(b.uri) : null;
    return i === 0 ? bin : null;
  });
}

/**
 * Every point of a VEC3 accessor, through `each`; false when they cannot be read here (compressed, sparse
 * or out of range), and the caller falls back on the accessor's declared bounds.
 */
function eachPoint(
  doc: GltfDocument,
  index: number,
  buffers: (Uint8Array | null)[],
  each: (x: number, y: number, z: number) => void,
): boolean {
  const acc = doc.accessors?.[index];
  if (!acc || acc.type !== "VEC3" || acc.sparse !== undefined || acc.bufferView === undefined) return false;
  const bv = doc.bufferViews?.[acc.bufferView];
  if (!bv || bv.extensions?.EXT_meshopt_compression !== undefined) return false;
  const buffer = buffers[bv.buffer];
  const size = COMPONENT_BYTES[acc.componentType];
  if (!buffer || size === undefined) return false;
  const stride = bv.byteStride ?? size * 3;
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const viewEnd = (bv.byteOffset ?? 0) + bv.byteLength;
  if (acc.count > 0 && (start + stride * (acc.count - 1) + size * 3 > viewEnd || viewEnd > buffer.length))
    return false;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const normalized = acc.normalized === true;
  for (let i = 0; i < acc.count; i += 1) {
    const at = start + i * stride;
    each(
      component(view, at, acc.componentType, normalized),
      component(view, at + size, acc.componentType, normalized),
      component(view, at + 2 * size, acc.componentType, normalized),
    );
  }
  return true;
}

function triangleCount(doc: GltfDocument, primitive: GltfPrimitive): number {
  const position = primitive.attributes.POSITION;
  const counted = primitive.indices ?? position;
  const count = counted === undefined ? 0 : (doc.accessors?.[counted]?.count ?? 0);
  const mode = primitive.mode ?? 4;
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

// ---- measuring ----------------------------------------------------------------------------------------

export interface ModelMeasure {
  /** Bounds of everything the default scene draws, in the file's units after its node transforms. */
  min: [number, number, number];
  max: [number, number, number];
  triangles: number;
  /** False when some points could not be read and their accessor's declared bounds stood in. */
  exact: boolean;
}

/** Bounds and triangle count of the default scene. Throws model.empty when it draws nothing. */
export function measureGltf(doc: GltfDocument, bin: Uint8Array | null): ModelMeasure {
  const buffers = bufferBytes(doc, bin);
  const scene = doc.scenes?.[doc.scene ?? 0];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const grow = (p: [number, number, number]) => {
    for (let k = 0; k < 3; k += 1) {
      const v = p[k] as number;
      if (v < (min[k] as number)) min[k] = v;
      if (v > (max[k] as number)) max[k] = v;
    }
  };
  let triangles = 0;
  let exact = true;
  // a node tree, by the format's rules; the visited set keeps a malformed file from looping
  const visited = new Set<number>();
  const stack: { index: number; parent: M4 }[] = (scene?.nodes ?? []).map((index) => ({
    index,
    parent: identity(),
  }));
  while (stack.length > 0) {
    const { index, parent } = stack.pop() as { index: number; parent: M4 };
    const node = doc.nodes?.[index];
    if (!node || visited.has(index)) continue;
    visited.add(index);
    const world = mul(parent, nodeMatrix(node));
    for (const child of node.children ?? []) stack.push({ index: child, parent: world });
    const mesh = node.mesh === undefined ? undefined : doc.meshes?.[node.mesh];
    for (const primitive of mesh?.primitives ?? []) {
      const position = primitive.attributes?.POSITION;
      if (position === undefined) continue;
      triangles += triangleCount(doc, primitive);
      const read = eachPoint(doc, position, buffers, (x, y, z) => grow(apply(world, x, y, z)));
      if (read) continue;
      const acc = doc.accessors?.[position];
      if (!acc?.min || !acc.max || acc.min.length < 3 || acc.max.length < 3) continue;
      exact = false;
      const [x0 = 0, y0 = 0, z0 = 0] = acc.min;
      const [x1 = 0, y1 = 0, z1 = 0] = acc.max;
      for (const x of [x0, x1])
        for (const y of [y0, y1]) for (const z of [z0, z1]) grow(apply(world, x, y, z));
    }
  }
  if (!Number.isFinite(min[0]) || !Number.isFinite(max[0]))
    throw new GltfError("model.empty", "the model has nothing to draw", "export the scene with its meshes");
  return { min, max, triangles, exact };
}

/**
 * Give every material a name, unique within the file: the names are the slots a person finishes the
 * model's parts by (ADR-010 D8), so one without a name would be a part nobody could choose.
 */
export function nameMaterials(doc: GltfDocument): string[] {
  const taken = new Set<string>();
  return (doc.materials ?? []).map((m, i) => {
    const wanted = (typeof m.name === "string" ? m.name.trim() : "") || `material-${i + 1}`;
    let name = wanted;
    for (let n = 2; taken.has(name); n += 1) name = `${wanted}-${n}`;
    taken.add(name);
    m.name = name;
    return name;
  });
}

/** The smallest a model's side may be, in metres: one millimetre, as for any product (ADR-010 D10). */
const MIN_SIDE_M = 0.001;

export interface ModelSummary {
  /** Width (x), depth (z) and height (y) in metres, each at least a millimetre. */
  size: { w: number; d: number; h: number };
  triangles: number;
  /** The material names, which are the model's slots. */
  slots: string[];
  exact: boolean;
}

function summary(m: ModelMeasure, slots: string[]): ModelSummary {
  // to the micrometre: past that a size is float noise, which would make two readings of one file differ
  const side = (k: 0 | 1 | 2) => Math.round(Math.max(MIN_SIDE_M, m.max[k] - m.min[k]) * 1e6) / 1e6;
  return { size: { w: side(0), d: side(2), h: side(1) }, triangles: m.triangles, slots, exact: m.exact };
}

/** What a binary glTF holds, read as it is: for a model this app normalised already. */
export function describeModel(bytes: Uint8Array): ModelSummary {
  const { json, bin } = readGlb(bytes);
  checkGltf(json);
  return summary(
    measureGltf(json, bin),
    (json.materials ?? []).map((m, i) => (typeof m.name === "string" && m.name) || `material-${i + 1}`),
  );
}

export interface NormaliseOptions {
  /** Quarter turns about the vertical, counter-clockwise seen from above, to bring its front to +z. */
  turn?: number;
  /** Quarter turns about x, top toward the viewer: one stands up a model made with z up. */
  tip?: number;
  /** Metres in one of the file's units: 1 for metres, as glTF says, 0.01 for a file in centimetres. */
  metresPerUnit?: number;
}

export interface PreparedModel extends ModelSummary {
  bytes: Uint8Array;
}

/**
 * Normalise a binary glTF for the catalog: name its materials, then put its scene under one root node
 * that tips, turns and scales it, stands it on y = 0 and centres its footprint on the origin. The
 * binary chunk is kept byte for byte.
 */
export function prepareModel(bytes: Uint8Array, options: NormaliseOptions = {}): PreparedModel {
  const { json, bin } = readGlb(bytes);
  checkGltf(json);
  const doc = JSON.parse(JSON.stringify(json)) as GltfDocument;
  const slots = nameMaterials(doc);
  const unit = options.metresPerUnit ?? 1;
  if (!(unit > 0) || !Number.isFinite(unit))
    throw new GltfError("model.units", "the units must be a positive number of metres", null);
  const s = identity();
  s[0] = unit;
  s[5] = unit;
  s[10] = unit;
  const shaped = mul(s, mul(turnMatrix(options.turn ?? 0), tipMatrix(options.tip ?? 0)));
  const nodes = doc.nodes ?? [];
  doc.nodes = nodes;
  const sceneIndex = doc.scene ?? 0;
  const scene = doc.scenes?.[sceneIndex];
  if (!scene)
    throw new GltfError("model.empty", "the model has nothing to draw", "export the scene with its meshes");
  const root: GltfNode = { name: "normalised", matrix: shaped, children: [...(scene.nodes ?? [])] };
  const rootIndex = nodes.length;
  nodes.push(root);
  scene.nodes = [rootIndex];
  doc.scene = sceneIndex;
  const m = measureGltf(doc, bin);
  const shift = identity();
  shift[12] = -(m.min[0] + m.max[0]) / 2;
  shift[13] = -m.min[1];
  shift[14] = -(m.min[2] + m.max[2]) / 2;
  root.matrix = mul(shift, shaped).map((v) => (Math.abs(v) < 1e-12 ? 0 : v));
  return { bytes: writeGlb(doc, bin), ...summary(m, slots) };
}
