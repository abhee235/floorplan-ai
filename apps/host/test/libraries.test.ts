// Catalog libraries installed from the editor (ADR-010 D10, spec 02 section 4, PRD P3-8): from a person's
// zip to an installed library, and back out again, with nothing installed unless all of it checks out.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { encodePng } from "@fpv/assets";
import { ensureSeed } from "@fpv/catalog";
import { CatalogStore } from "@fpv/catalog/store";
import { describe, expect, it } from "vitest";
import { type Entry, makeZip } from "../../../packages/exporters/test/zip-maker.js";
import { Libraries, LibraryError, TextureImages, UserTextures } from "../src/index.js";

const NOW = "2026-11-18T09:00:00.000Z";
const tmp = () => mkdtempSync(join(tmpdir(), "fpv-libraries-"));
const text = (s: string) => new TextEncoder().encode(s);
const picture = (shade: number) =>
  encodePng({ width: 8, height: 8, rgb: new Uint8Array(8 * 8 * 3).fill(shade) }, (d) => deflateSync(d));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A library's zip: library.json and a texture, in a folder of its own, deflated, as a person zips a folder. */
function libraryZip(
  options: { id?: string; version?: string; png?: Uint8Array; extra?: Entry[]; declared?: string } = {},
) {
  const png = options.png ?? picture(90);
  const hex = options.declared ?? sha(png);
  const id = options.id ?? "acme-finishes";
  const licence = { id: "CC0-1.0", author: "Acme", sourceUrl: null, attribution: null };
  const manifest = {
    id,
    name: "Acme finishes",
    version: options.version ?? "1.0.0",
    licence,
    provider: "Acme",
    products: [],
    textures: [
      {
        id: `${id}/slate`,
        name: "Slate",
        image: `sha256:${hex}`,
        widthMm: 600,
        heightMm: 600,
        transparent: false,
        creator: "Acme",
        licence,
        tags: ["floor"],
      },
    ],
  };
  return makeZip([
    { name: "acme/" },
    { name: "acme/library.json", data: text(JSON.stringify(manifest)), deflate: true },
    { name: `acme/textures/${sha(png)}.png`, data: png, deflate: true, streamed: true },
    { name: "__MACOSX/acme/._library.json", data: text("resource fork") },
    ...(options.extra ?? []),
  ]);
}

function setup() {
  const data = tmp();
  const store = CatalogStore.open(":memory:");
  ensureSeed(store, NOW);
  const own = new UserTextures(store, data);
  const images = new TextureImages(store, data, own);
  let changes = 0;
  const libraries = new Libraries(
    store,
    data,
    () => NOW,
    () => {
      changes += 1;
      images.forget();
    },
  );
  return { data, store, own, images, libraries, changes: () => changes };
}
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof LibraryError) return e.code;
    throw e;
  }
  return "installed";
};
const incoming = (data: string) =>
  existsSync(join(data, "libraries"))
    ? readdirSync(join(data, "libraries")).filter((n) => n.startsWith(".incoming"))
    : [];

describe("libraries installed from the editor (P3-8)", () => {
  it("installs a library from its zip, folder and all, and lists it beside the built-in ones", () => {
    const { data, store, images, libraries, changes } = setup();
    const before = libraries.list();
    expect(before.every((l) => l.builtIn)).toBe(true);
    // the missing picture is asked for once, and remembered as missing
    expect(images.image("acme-finishes/slate")).toBeNull();
    const { library, replaced } = libraries.installZip(libraryZip());
    expect(replaced).toBe(false);
    expect(library).toMatchObject({
      id: "acme-finishes",
      version: "1.0.0",
      name: "Acme finishes",
      provider: "Acme",
      licence: "CC0-1.0",
      textureCount: 1,
      builtIn: false,
    });
    expect(libraries.list().map((l) => l.id)).toContain("acme-finishes");
    expect(store.getTexture("acme-finishes/slate")?.name).toBe("Slate");
    // installing dropped what the images knew, so the picture is found now
    expect(changes()).toBe(1);
    expect(images.image("acme-finishes/slate")?.bytes).toEqual(picture(90));
    expect(incoming(data)).toEqual([]);
    expect(libraries.installZip(libraryZip()).replaced).toBe(true);
    store.close();
  });

  it("installs nothing from a zip that does not check out, and leaves nothing behind", () => {
    const { data, store, libraries } = setup();
    // a texture whose bytes are not what the manifest says
    expect(refusal(() => libraries.installZip(libraryZip({ declared: sha(picture(1)) })))).toBe(
      "texture.missing",
    );
    const swapped = libraryZip({
      declared: sha(picture(1)),
      extra: [{ name: `acme/textures/${sha(picture(1))}.png`, data: picture(2) }],
    });
    expect(refusal(() => libraries.installZip(swapped))).toBe("texture.hash");
    // a name that climbs out of the library's folder, or names a drive
    expect(
      refusal(() =>
        libraries.installZip(libraryZip({ extra: [{ name: "acme/../evil.txt", data: text("x") }] })),
      ),
    ).toBe("library.unsafe");
    expect(
      refusal(() =>
        libraries.installZip(libraryZip({ extra: [{ name: "acme/C:/x.txt", data: text("x") }] })),
      ),
    ).toBe("library.unsafe");
    expect(refusal(() => libraries.installZip(libraryZip({ id: "seed" })))).toBe("library.reserved");
    expect(refusal(() => libraries.installZip(makeZip([{ name: "readme.txt", data: text("hi") }])))).toBe(
      "library.missing",
    );
    expect(refusal(() => libraries.installZip(text("not a zip")))).toBe("library.unreadable");
    expect(refusal(() => libraries.installZip(makeZip([{ name: "library.json", data: text("{") }])))).toBe(
      "library.invalid",
    );
    expect(libraries.list().some((l) => l.id === "acme-finishes")).toBe(false);
    expect(store.getTexture("acme-finishes/slate")).toBeNull();
    expect(incoming(data)).toEqual([]);
    store.close();
  });

  it("removes one version and its files, and never a library the app keeps itself", () => {
    const { data, store, libraries } = setup();
    libraries.installZip(libraryZip());
    expect(existsSync(join(data, "libraries", "acme-finishes", "1.0.0"))).toBe(true);
    expect(libraries.uninstall("acme-finishes", "1.0.0")).toBe(true);
    expect(existsSync(join(data, "libraries", "acme-finishes", "1.0.0"))).toBe(false);
    expect(store.getTexture("acme-finishes/slate")).toBeNull();
    expect(libraries.uninstall("acme-finishes", "1.0.0")).toBe(false);
    expect(refusal(() => libraries.uninstall("seed", "1.0.0"))).toBe("library.built-in");
    expect(refusal(() => libraries.uninstall("generated", "1.0.0"))).toBe("library.built-in");
    store.close();
  });

  it("keeps the person's own imported textures through an install and an uninstall", () => {
    // Found in the browser: removing a library took a picture imported earlier out of the catalog, and
    // the wall wearing it went plain on the next load.
    const { store, own, images, libraries } = setup();
    const mine = picture(200);
    const { texture } = own.add({
      bytes: mine,
      mime: "image/png",
      name: "Slate tiles",
      widthMm: 300,
      heightMm: 300,
      tags: ["wall"],
    });
    libraries.installZip(libraryZip());
    libraries.uninstall("acme-finishes", "1.0.0");
    expect(store.getTexture(texture.id)?.name).toBe("Slate tiles");
    expect(images.image(texture.id)?.bytes).toEqual(mine);
    store.close();
  });
});
