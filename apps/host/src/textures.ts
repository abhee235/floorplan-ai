// Texture images for the viewer and the glTF export (P3-5). A drawn texture is rendered and encoded on
// first use and kept; a library texture is read from the library's copy under the data directory, where
// the installer put it after checking its hash (spec 02 section 4).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { encodePng, renderGeneratedTexture } from "@fpv/assets";
import type { Texture } from "@fpv/catalog";
import { libraryDir } from "@fpv/catalog/store";

export interface TextureImage {
  bytes: Uint8Array;
  type: string;
}

/** What the catalog store answers about a texture; CatalogStore has both. */
export interface TextureLookup {
  texture(id: string): Texture | null;
  textureOrigin(id: string): { texture: Texture; library: string; version: string } | null;
}

const TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** Pixels on a side of a drawn texture: enough for a floor seen across a room, small enough to send. */
const DRAWN_SIZE = 256;

export class TextureImages {
  private readonly cache = new Map<string, TextureImage | null>();

  constructor(
    private readonly lookup: TextureLookup,
    private readonly dataDir: string,
  ) {}

  /** The image for a texture id, or null when the catalog has no such texture or its file is gone. */
  image(id: string): TextureImage | null {
    if (this.cache.has(id)) return this.cache.get(id) ?? null;
    const found = this.load(id);
    this.cache.set(id, found);
    return found;
  }

  private load(id: string): TextureImage | null {
    const texture = this.lookup.texture(id);
    if (!texture) return null;
    if (texture.image.startsWith("generated:")) {
      const pixels = renderGeneratedTexture(texture.image.slice("generated:".length), DRAWN_SIZE);
      return pixels ? { bytes: encodePng(pixels, (d) => deflateSync(d)), type: "image/png" } : null;
    }
    const origin = this.lookup.textureOrigin(id);
    if (!origin) return null;
    const hex = texture.image.slice("sha256:".length);
    const folder = join(libraryDir(this.dataDir, origin.library, origin.version), "textures");
    if (!existsSync(folder)) return null;
    const file = readdirSync(folder).find((f) => f.startsWith(hex));
    const type = file ? TYPES[extname(file).toLowerCase()] : undefined;
    if (!file || !type) return null;
    return { bytes: new Uint8Array(readFileSync(join(folder, file))), type };
  }
}
