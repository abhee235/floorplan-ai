// A person's own 3D models (ADR-010 D10, PRD P3-8): each normalised file kept once under
// <data>/user/models/<sha256>.glb, its asset in the catalog's "user" library under a key made from that
// hash, and a product made of it, tagged "imported", that the catalog offers like any other. A project
// that uses one carries the file in its assets/ folder (ADR-012 D1), and an installation that opens the
// project takes it in.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AssetEntry, describeModel, GltfError, prepareModel } from "@fpv/assets";
import { type Product, ProductSnapshot } from "@fpv/catalog";
import type { CatalogStore } from "@fpv/catalog/store";
import type { Project, Size3 } from "@fpv/ir";
import type { ModelImporter, ModelImportRequest, ModelImportResult } from "@fpv/tools";
import type { ProjectAsset } from "./user-textures.js";
import { USER_LIBRARY } from "./user-textures.js";

/** The version every user asset is filed under: the "user" library has no manifest to give one. */
export const USER_VERSION = "0.0.0";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const HEX = /^[0-9a-f]{64}$/;

/** "user/<first 16 hex of the file's hash>/std": the same file is the same key on every installation. */
export function userModelKey(hex: string): string {
  return `${USER_LIBRARY}/${hex.slice(0, 16)}/std`;
}

/** Where a product of a category usually goes; a person moves it from there like any other item. */
function mountFor(category: string): ("floor" | "wall" | "ceiling" | "table")[] {
  if (["display", "whiteboard", "touch-panel", "scheduler"].includes(category)) return ["wall"];
  if (category === "ceiling-speaker" || category === "ceiling-mic") return ["ceiling"];
  if (category === "table-mic") return ["table"];
  return ["floor"];
}

const mm = (m: number) => Math.max(1, Math.round(m * 1000));

export class UserModels implements ModelImporter {
  /** Where the files are kept: <data>/user/models/<sha256>.glb. */
  readonly dir: string;

  constructor(
    private readonly catalog: CatalogStore,
    dataDir: string,
    private readonly now: () => string,
  ) {
    this.dir = join(dataDir, USER_LIBRARY, "models");
  }

  add(request: ModelImportRequest): ModelImportResult {
    const prepared = prepareModel(request.bytes, {
      turn: request.turn,
      tip: request.tip,
      metresPerUnit: request.metresPerUnit,
    });
    const hex = sha256(prepared.bytes);
    const key = userModelKey(hex);
    this.keep(hex, prepared.bytes);
    const warnings: string[] = [];
    if (!prepared.exact)
      warnings.push(
        "Some of the model's parts are compressed, so its size was read from the bounds the file declares; check it.",
      );
    if (!this.catalog.assetEntry(key))
      this.catalog.upsertAsset(
        entryFor(key, hex, prepared.bytes.length, prepared.size, prepared.triangles, prepared.slots),
        { library: USER_LIBRARY, version: USER_VERSION },
      );
    const dims: Size3 = request.size ?? {
      w: mm(prepared.size.w),
      d: mm(prepared.size.d),
      h: mm(prepared.size.h),
    };
    const result = (product: Product, existing: boolean): ModelImportResult => ({
      product: { id: product.id, name: product.name, category: product.category, dims: product.dims },
      assetKey: key,
      triangles: prepared.triangles,
      slots: prepared.slots,
      existing,
      warnings,
    });
    // the same model at the same size is the product already made of it
    const same = this.catalog
      .byCategory(request.category)
      .find((p) => p.assetKey === key && p.dims.w === dims.w && p.dims.d === dims.d && p.dims.h === dims.h);
    if (same) return result(same, true);
    const at = this.now();
    const id = this.freeProductId(request.name);
    this.catalog.insert(
      {
        id,
        make: "Own model",
        model: request.name,
        name: request.name,
        category: request.category as Product["category"],
        dims,
        mount: { kinds: mountFor(request.category) },
        // the person's own model: they decide its size per item, as for a recipe
        deformable: true,
        assetKey: key,
        materialSlots: prepared.slots,
        verification: {
          status: "manual",
          confidence: 1,
          sources: [],
          verifiedAt: null,
          notes: "a model a person imported",
        },
        lifecycle: "active",
        tags: [...new Set(["imported", ...request.tags])],
        createdAt: at,
        updatedAt: at,
      },
      { now: at },
    );
    const product = this.catalog.get(id);
    if (!product)
      throw new GltfError("model.catalog", "the product could not be written to the catalog", null);
    return result(product, false);
  }

  /** The kept file with this hash, or null. */
  fileFor(hex: string): string | null {
    if (!HEX.test(hex)) return null;
    const path = join(this.dir, `${hex}.glb`);
    return existsSync(path) ? path : null;
  }

  /**
   * The models a project uses that this installation keeps, to be copied into its assets/ when it is
   * saved: those its products' snapshots name, and nothing imported but never placed.
   */
  assetsFor(project: Project): (ProjectAsset & { source: string })[] {
    const out: (ProjectAsset & { source: string })[] = [];
    const seen = new Set<string>();
    for (const snap of Object.values(project.catalogRefs)) {
      const key = (snap as { assetKey?: unknown }).assetKey;
      if (typeof key !== "string" || !key.startsWith(`${USER_LIBRARY}/`) || seen.has(key)) continue;
      const origin = this.catalog.assetOrigin(key);
      const hex = origin?.library === USER_LIBRARY ? origin.entry.sha256 : null;
      const source = hex ? this.fileFor(hex) : null;
      if (!hex || !source) continue;
      seen.add(key);
      out.push({ key, file: `${hex}.glb`, sha256: hex, source });
    }
    return out;
  }

  /**
   * A project's carried models, offered back as it opens: each file that is new here and whose bytes
   * match its name is kept and its asset added, and each imported product the catalog lacks is added from
   * the project's own snapshot of it. Returns the asset keys taken in. A file that cannot be read costs
   * the project that model, never its opening.
   */
  adopt(project: Project, assetsDir: string): string[] {
    const adopted: string[] = [];
    const carried = existsSync(assetsDir) ? readdirSync(assetsDir).filter((f) => f.endsWith(".glb")) : [];
    for (const [id, snap] of Object.entries(project.catalogRefs)) {
      const key = (snap as { assetKey?: unknown }).assetKey;
      if (typeof key !== "string" || !key.startsWith(`${USER_LIBRARY}/`)) continue;
      if (!this.catalog.assetEntry(key)) {
        const prefix = key.split("/")[1] ?? "";
        const file = carried.find((f) => f.startsWith(prefix) && HEX.test(f.slice(0, -4)));
        if (!file) continue;
        const hex = file.slice(0, -4);
        try {
          const bytes = new Uint8Array(readFileSync(join(assetsDir, file)));
          // a file whose bytes do not match its name is not the model the project meant
          if (sha256(bytes) !== hex || userModelKey(hex) !== key) continue;
          const read = describeModel(bytes);
          this.keep(hex, bytes);
          this.catalog.upsertAsset(entryFor(key, hex, bytes.length, read.size, read.triangles, read.slots), {
            library: USER_LIBRARY,
            version: USER_VERSION,
          });
          adopted.push(key);
        } catch {
          continue;
        }
      }
      if (!this.catalog.get(id)) {
        const parsed = ProductSnapshot.safeParse(snap);
        if (!parsed.success) continue;
        const { snapshotAt, ...product } = parsed.data;
        try {
          this.catalog.insert(
            { ...product, tags: ["imported"], createdAt: snapshotAt, updatedAt: snapshotAt },
            { now: snapshotAt },
          );
        } catch {
          // an id this catalog already uses for something else keeps its own; the project keeps its snapshot
        }
      }
    }
    return adopted;
  }

  private keep(hex: string, bytes: Uint8Array): void {
    mkdirSync(this.dir, { recursive: true });
    const target = join(this.dir, `${hex}.glb`);
    if (existsSync(target)) return;
    writeFileSync(`${target}.tmp`, bytes);
    renameSync(`${target}.tmp`, target);
  }

  /** "user-<slug>" from a name, numbered when the id is taken. */
  private freeProductId(name: string): string {
    const slug =
      name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/, "") || "model";
    let id = `user-${slug}`;
    for (let n = 2; this.catalog.get(id); n += 1) id = `user-${slug}-${n}`;
    return id;
  }
}

function entryFor(
  key: string,
  hex: string,
  bytes: number,
  size: { w: number; d: number; h: number },
  triangles: number,
  slots: string[],
): AssetEntry {
  return {
    key,
    kind: "gltf",
    file: `${hex}.glb`,
    recipe: null,
    bbox: size,
    triangles,
    bytes,
    sha256: hex,
    materialSlots: slots,
    articulations: [],
    presets: {},
    planIcon: null,
    licence: { id: "own", author: null, sourceUrl: null, attribution: null },
    tags: ["imported"],
  };
}
