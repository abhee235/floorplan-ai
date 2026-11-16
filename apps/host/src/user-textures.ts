// Textures a person imported (ADR-010 D10, PRD P3-8). Each picture is kept once, under the data directory,
// named by its hash, and the catalog offers it as a texture of the "user" library beside the ones the app
// draws. A project that uses one carries the picture in its own assets/ folder (ADR-012 D1), and an
// installation that opens such a project takes the picture and its texture back in, so the project looks
// the same wherever it is opened.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { inflateSync } from "node:zlib";
import type { Texture } from "@fpv/catalog";
import type { CatalogStore } from "@fpv/catalog/store";
import type { Project } from "@fpv/ir";
import type { TextureImporter, TextureImportRequest } from "@fpv/tools";

/** The library imported textures belong to: their ids read "user/<slug>". */
export const USER_LIBRARY = "user";

const EXTENSION: Record<TextureImportRequest["mime"], string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

/** A custom file a project carries, as its manifest lists it: keyed by its hash, which is also its name. */
export interface ProjectAsset {
  key: string;
  file: string;
  sha256: string;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export class UserTextures implements TextureImporter {
  /** Where the pictures are kept: <data>/user/textures/<sha256>.<ext>. */
  readonly dir: string;

  constructor(
    private readonly catalog: CatalogStore,
    dataDir: string,
  ) {
    this.dir = join(dataDir, USER_LIBRARY, "textures");
  }

  add(request: TextureImportRequest): { texture: Texture; existing: boolean } {
    const hex = sha256(request.bytes);
    const image = `sha256:${hex}`;
    // The same picture twice is one texture: a second import of it is the first one, whatever it is called.
    const same = this.catalog
      .textures()
      .find((t) => t.image === image && t.id.startsWith(`${USER_LIBRARY}/`));
    if (same && this.fileFor(hex)) return { texture: same, existing: true };
    this.keep(hex, EXTENSION[request.mime], request.bytes);
    const texture = this.catalog.upsertTexture(
      {
        id: same?.id ?? this.freeId(request.name),
        name: request.name,
        image,
        widthMm: request.widthMm,
        heightMm: request.heightMm,
        transparent: hasTransparency(request.bytes, request.mime),
        creator: null,
        licence: { id: "own", author: null, sourceUrl: null, attribution: null },
        tags: [...new Set(["imported", ...request.tags])],
      },
      { library: USER_LIBRARY },
    );
    return { texture, existing: false };
  }

  /** The kept picture with this hash, or null. */
  fileFor(hex: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(hex) || !existsSync(this.dir)) return null;
    const name = readdirSync(this.dir).find((f) => f.startsWith(`${hex}.`));
    return name ? join(this.dir, name) : null;
  }

  /**
   * The pictures a project uses that this installation keeps, to be copied into its assets/ when it is
   * saved. Only what the project's textures name: a picture imported and never used stays here.
   */
  assetsFor(project: Project): (ProjectAsset & { source: string })[] {
    const out: (ProjectAsset & { source: string })[] = [];
    const seen = new Set<string>();
    for (const t of Object.values(project.textures)) {
      const image = (t as { image?: unknown }).image;
      if (typeof image !== "string" || !image.startsWith("sha256:")) continue;
      const hex = image.slice("sha256:".length);
      const source = this.fileFor(hex);
      if (!source || seen.has(hex)) continue;
      seen.add(hex);
      out.push({ key: hex, file: basename(source), sha256: hex, source });
    }
    return out;
  }

  /**
   * A project's carried pictures, offered back to this installation as it opens: each picture that is new
   * here and whose bytes match its name is kept, and each imported texture the catalog lacks is added from
   * the project's own copy of its record. Returns the ids of the textures taken in.
   */
  adopt(project: Project, assetsDir: string): string[] {
    const adopted: string[] = [];
    for (const [id, snap] of Object.entries(project.textures)) {
      const image = (snap as { image?: unknown }).image;
      if (!id.startsWith(`${USER_LIBRARY}/`) || typeof image !== "string" || !image.startsWith("sha256:"))
        continue;
      const hex = image.slice("sha256:".length);
      if (!this.fileFor(hex)) {
        const carried = existsSync(assetsDir)
          ? readdirSync(assetsDir).find((f) => f.startsWith(`${hex}.`))
          : null;
        if (!carried) continue;
        const bytes = new Uint8Array(readFileSync(join(assetsDir, carried)));
        // a file whose bytes do not match its name is not the picture the project meant
        if (sha256(bytes) !== hex) continue;
        this.keep(hex, extname(carried).toLowerCase(), bytes);
      }
      if (!this.catalog.getTexture(id)) {
        this.catalog.upsertTexture(snap as Texture, { library: USER_LIBRARY });
        adopted.push(id);
      }
    }
    return adopted;
  }

  /** Copy a kept picture to a project's assets/ folder, unless it is there already. */
  static carry(asset: { source: string; file: string }, assetsDir: string): void {
    const target = join(assetsDir, asset.file);
    if (existsSync(target)) return;
    mkdirSync(assetsDir, { recursive: true });
    copyFileSync(asset.source, `${target}.tmp`);
    renameSync(`${target}.tmp`, target);
  }

  private keep(hex: string, ext: string, bytes: Uint8Array): void {
    mkdirSync(this.dir, { recursive: true });
    const target = join(this.dir, `${hex}${ext}`);
    if (existsSync(target)) return;
    writeFileSync(`${target}.tmp`, bytes);
    renameSync(`${target}.tmp`, target);
  }

  /** "user/<slug>" from a name, numbered when the name is taken. */
  private freeId(name: string): string {
    const slug =
      name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/, "") || "texture";
    let id = `${USER_LIBRARY}/${slug}`;
    for (let n = 2; this.catalog.getTexture(id); n += 1) id = `${USER_LIBRARY}/${slug}-${n}`;
    return id;
  }
}

// ---- transparency ----------------------------------------------------------------------------------------

/** Past this many pixels a PNG is taken at its word rather than read through; it is a texture, not a poster. */
const SCAN_LIMIT = 40_000_000;

/**
 * Whether a picture has any see-through pixel, found once at import (ADR-010 D7) so the viewer can choose
 * its material without reading pixels. A JPEG never has one. A WebP says so in its header. A PNG with an
 * alpha channel is read through, because most such files are opaque everywhere and saying otherwise would
 * draw a solid carpet as glass.
 */
export function hasTransparency(bytes: Uint8Array, mime: TextureImportRequest["mime"]): boolean {
  if (mime === "image/jpeg") return false;
  if (mime === "image/webp") return webpAlpha(bytes);
  return pngAlpha(bytes);
}

function webpAlpha(b: Uint8Array): boolean {
  const tag = String.fromCharCode(...b.subarray(12, 16));
  if (tag === "VP8X") return ((b[20] ?? 0) & 0x10) !== 0;
  if (tag === "VP8L") {
    // after the signature byte: 14 bits of width, 14 of height, then the alpha bit
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
    return ((bits >>> 28) & 1) === 1;
  }
  return false;
}

function pngAlpha(b: Uint8Array): boolean {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const depth = b[24] ?? 8;
  const colour = b[25] ?? 2;
  const interlaced = (b[28] ?? 0) !== 0;
  const idat: Uint8Array[] = [];
  let at = 8;
  while (at + 8 <= b.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    const data = b.subarray(at + 8, at + 8 + length);
    if (type === "tRNS") {
      // a palette's own alphas say it; for grey or truecolour a transparent key colour is transparency
      return colour === 3 ? data.some((a) => a < 255) : true;
    }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
    at += 12 + length;
  }
  if (colour !== 4 && colour !== 6) return false;
  if (interlaced || width * height > SCAN_LIMIT || (depth !== 8 && depth !== 16)) return true;
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return true;
  }
  const channels = colour === 6 ? 4 : 2;
  const bpp = (channels * depth) / 8;
  const stride = width * bpp;
  const alphaAt = (channels - 1) * (depth / 8);
  let prev = new Uint8Array(stride);
  let row = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const v = raw[start + 1 + x] ?? 0;
      const a = x >= bpp ? (row[x - bpp] as number) : 0;
      const up = prev[x] as number;
      const c = x >= bpp ? (prev[x - bpp] as number) : 0;
      let out = v;
      if (filter === 1) out = v + a;
      else if (filter === 2) out = v + up;
      else if (filter === 3) out = v + ((a + up) >> 1);
      else if (filter === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      }
      row[x] = out & 0xff;
    }
    for (let x = alphaAt; x < stride; x += bpp) {
      const alpha = depth === 8 ? (row[x] as number) : ((row[x] as number) << 8) | (row[x + 1] as number);
      if (alpha < (depth === 8 ? 255 : 65535)) return true;
    }
    [prev, row] = [row, prev];
  }
  return false;
}
