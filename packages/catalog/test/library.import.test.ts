import { describe, expect, it } from "vitest";
import {
  type FlatImportOptions,
  type ImportedPiece,
  importFlatCatalog,
  importFlatTextures,
  parseProperties,
  validateProduct,
} from "../src/index.js";

const NOW = "2026-09-15T12:00:00.000Z";
const opts: FlatImportOptions = { libraryId: "acme-lib", source: "library", now: NOW };

/** One complete piece per index; extra keys per index are appended. */
function piece(i: number, extra: Record<string, string> = {}, base: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    name: `Piece ${i}`,
    category: "Office",
    icon: `icons/p${i}.png`,
    model: `models/p${i}.obj`,
    width: "60",
    depth: "50",
    height: "70",
    movable: "true",
    doorOrWindow: "false",
    ...base,
  };
  return [...Object.entries(defaults), ...Object.entries(extra)].map(([k, v]) => `${k}#${i}=${v}`).join("\n");
}

function ok(text: string, o: FlatImportOptions = opts): ImportedPiece[] {
  const r = importFlatCatalog(text, o);
  if (!r.ok) throw new Error(r.error);
  return r.items;
}

function fail(text: string, o: FlatImportOptions = opts): string {
  const r = importFlatCatalog(text, o);
  if (r.ok) throw new Error("expected a failure");
  return r.error;
}

describe("properties parsing", () => {
  it("reads key=value and key: value, comments, continuations and unicode escapes", () => {
    const p = parseProperties(
      [
        "# comment",
        "! also",
        "a=1",
        "b: two words",
        "c=first \\",
        "    second",
        "d=caf\\u00e9",
        "e=x\\ty",
      ].join("\n"),
    );
    expect([...p.entries()]).toEqual([
      ["a", "1"],
      ["b", "two words"],
      ["c", "first second"],
      ["d", "café"],
      ["e", "x\ty"],
    ]);
  });
});

describe("flat catalog scanning (C-001..C-005)", () => {
  it("C-001 pieces are 1-based and scanning stops at the first missing name", () => {
    expect(ok(`${piece(1)}\n${piece(3)}`).map((p) => p.product.name)).toEqual(["Piece 1"]);
  });

  it("C-002 ignored#i=true skips that piece and continues", () => {
    const items = ok(`${piece(1)}\n${piece(2, { ignored: "true" })}\n${piece(3)}`);
    expect(items.map((p) => p.product.name)).toEqual(["Piece 1", "Piece 3"]);
  });

  it("C-003 (reversed) ignored#i=false is simply not ignored and never stops the scan", () => {
    const items = ok(`${piece(1)}\n${piece(2, { ignored: "false" })}\n${piece(3)}`);
    expect(items.map((p) => p.product.name)).toEqual(["Piece 1", "Piece 2", "Piece 3"]);
  });

  it("C-004 C-005 a missing mandatory key names itself and the whole file contributes nothing", () => {
    const text = `${piece(1)}\n${piece(2).replace(/width#2=60\n?/, "")}`;
    expect(fail(text)).toBe("missing mandatory key width#2");
    const r = importFlatCatalog(text, opts);
    expect(r.ok).toBe(false);
  });
});

describe("piece fields (C-006..C-029)", () => {
  it("C-006 (reversed) zero and negative dimensions are refused; C-007 a malformed number is an error", () => {
    expect(fail(piece(1, {}, { width: "0" }))).toBe("width#1: must be greater than zero, got 0");
    expect(fail(piece(1, {}, { depth: "-5" }))).toBe("depth#1: must be greater than zero, got -5");
    expect(fail(piece(1, {}, { height: "abc" }))).toBe("height#1: not a number: abc");
  });

  it("C-008 defaults: no elevation, drops on top at the full height, deformable, no price, no rotation, no tags", () => {
    const [p] = ok(piece(1));
    const product = (p as ImportedPiece).product;
    expect(product.dims).toEqual({ w: 600, d: 500, h: 700 });
    expect(product.mount).toEqual({ kinds: ["floor"], vesa: null, defaultHeight: null });
    expect(product.mountPoints).toEqual([{ name: "top", kind: "surface", dropRatio: 1, offset: null }]);
    expect(product.deformable).toBe(true);
    expect(product.price).toBeNull();
    expect(product.meshRotation).toBeNull();
    expect(product.tags).toEqual([]);
    expect(product.createdAt).toBe(NOW);
    expect(product.make).toBe("acme-lib");
    expect(product.id).toBe("acme-lib-piece-1");
    expect(product.verification.status).toBe("unverified");
    expect(validateProduct(product).filter((x) => x.severity === "error")).toEqual([]);
  });

  it("C-009 dropOnTopElevation is a fraction of the height; negative means nothing drops there", () => {
    const [a] = ok(piece(1, { dropOnTopElevation: "48" }));
    expect((a as ImportedPiece).product.mountPoints[0]?.dropRatio).toBeCloseTo(48 / 70, 6);
    const [b] = ok(piece(1, { dropOnTopElevation: "-1" }));
    expect((b as ImportedPiece).product.mountPoints[0]?.dropRatio).toBeNull();
  });

  it("elevation, creator, price and currency map to mount height, make and a list price expiring in 90 days", () => {
    const [p] = ok(piece(1, { elevation: "90", creator: "Acme Furniture", price: "199.5", currency: "eur" }));
    const product = (p as ImportedPiece).product;
    expect(product.mount.defaultHeight).toBe(900);
    expect(product.make).toBe("Acme Furniture");
    expect(product.price).toMatchObject({ amount: 199.5, currency: "EUR", type: "list", capturedAt: NOW });
    expect(Date.parse(product.price?.expiresAt as string) - Date.parse(NOW)).toBe(90 * 86_400_000);
  });

  it("C-015 subtype: door or window first, then light, then shelf unit, then category words", () => {
    const names = (text: string) => ok(text).map((p) => p.product.category);
    expect(names(piece(1, {}, { doorOrWindow: "true" }))).toEqual(["door"]);
    expect(names(piece(1, {}, { doorOrWindow: "true", name: "Bay window" }))).toEqual(["window"]);
    expect(
      names(
        piece(1, { lightSourceX: "30", lightSourceY: "25", lightSourceZ: "60", lightSourceColor: "#FFFFFF" }),
      ),
    ).toEqual(["lighting"]);
    expect(names(piece(1, { shelfElevations: "20 40" }))).toEqual(["storage"]);
    expect(names(piece(1, {}, { category: "Living room", name: "Sofa" }))).toEqual(["sofa"]);
    expect(names(piece(1, {}, { category: "Living room", name: "Armchair" }))).toEqual(["chair"]);
    expect(names(piece(1, {}, { category: "Kitchen", name: "Fridge" }))).toEqual(["appliance"]);
    expect(names(piece(1, {}, { category: "Miscellaneous", name: "Thing" }))).toEqual(["other"]);
  });

  it("C-014 light source lists must have equal counts, diameters included when present", () => {
    const lights = {
      lightSourceX: "30 40",
      lightSourceY: "25 25",
      lightSourceZ: "60 60",
      lightSourceColor: "#FFFFFF #FFFFEE",
    };
    const [p] = ok(piece(1, lights));
    expect((p as ImportedPiece).product.specs.lightCount).toBe(2);
    expect(fail(piece(1, { ...lights, lightSourceColor: "#FFFFFF" }))).toBe(
      "lightSourceColor#1: expected 2 values in lightSourceColor, got 1",
    );
    expect(fail(piece(1, { ...lights, lightSourceDiameter: "5" }))).toBe(
      "lightSourceDiameter#1: expected 2 values",
    );
    expect(fail(piece(1, { lightSourceX: "30" }))).toMatch(/^lightSourceY#1: expected 1 values/);
  });

  it("C-016 shelf boxes come in sixes and shelf elevations are counted", () => {
    expect(fail(piece(1, { shelfBoxes: "0 0 0 1 1 1 0" }))).toBe(
      "shelfBoxes#1: expected a multiple of 6 values, got 7",
    );
    const [p] = ok(piece(1, { shelfBoxes: "0 0 0 1 1 1 0 0 0.5 1 1 1", shelfElevations: "20 40 60" }));
    expect((p as ImportedPiece).product.specs).toMatchObject({ shelfBoxes: 2, shelfLevels: 3 });
  });

  it("C-017 (reversed) modelRotation needs exactly nine numbers; P-025 near-integers are snapped", () => {
    expect(fail(piece(1, { modelRotation: "1 0 0 0 1 0" }))).toBe(
      "modelRotation needs exactly 9 values, got 6",
    );
    expect(fail(piece(1, { modelRotation: "1 0 0 0 1 0 0 0 x" }))).toBe(
      "modelRotation value 9 is not a number: x",
    );
    const [p] = ok(piece(1, { modelRotation: "0.9999999 0 0 0 1 0 0 0 -0.9999995" }));
    expect((p as ImportedPiece).product.meshRotation).toEqual([1, 0, 0, 0, 1, 0, 0, 0, -1]);
  });

  it("C-018 modelFlags combine bit 1 (back faces) and bit 2 (hidden edge colour); a non-number is an error", () => {
    const [p] = ok(piece(1, { modelFlags: "3" }));
    expect((p as ImportedPiece).product.specs).toMatchObject({ backFaceShown: true, edgeColourHidden: true });
    const [q] = ok(piece(1, { modelFlags: "2" }));
    expect((q as ImportedPiece).product.specs.backFaceShown).toBeUndefined();
    expect(fail(piece(1, { modelFlags: "x" }))).toBe("modelFlags#1: not a number: x");
  });

  it("C-019 a declared model size is carried as bytes; without one the file is measured later", () => {
    expect((ok(piece(1, { modelSize: "1234" }))[0] as ImportedPiece).modelBytes).toBe(1234);
    expect((ok(piece(1))[0] as ImportedPiece).modelBytes).toBeNull();
  });

  it("C-020 C-021 (reversed) multi-part models are refused: one file per asset, by hash", () => {
    expect(fail(piece(1, { multiPartModel: "true" }))).toBe(
      "multiPartModel#1: multi-part models are not supported; provide a single glTF",
    );
    expect(ok(piece(1, { multiPartModel: "false" }))).toHaveLength(1);
  });

  it("C-022 creationDate is strictly yyyy-MM-dd", () => {
    expect((ok(piece(1, { creationDate: "2020-01-02" }))[0] as ImportedPiece).product.createdAt).toBe(
      "2020-01-02T00:00:00.000Z",
    );
    expect(fail(piece(1, { creationDate: "01/02/2020" }))).toBe(
      "creationDate#1: can't parse date 01/02/2020; expected yyyy-MM-dd",
    );
    expect(fail(piece(1, { creationDate: "2020-02-30" }))).toMatch(/not a calendar date/);
  });

  it("C-023 tags split on commas with surrounding space; empty entries dropped", () => {
    expect((ok(piece(1, { tags: "a , b,,c " }))[0] as ImportedPiece).product.tags).toEqual(["a", "b", "c"]);
  });

  it("C-024 references: absolute URLs pass, relative paths normalise, archive and query forms are refused", () => {
    expect((ok(piece(1, {}, { model: "https://example.com/m.glb" }))[0] as ImportedPiece).modelFile).toBe(
      "https://example.com/m.glb",
    );
    // a properties file escapes backslashes, so the value below reads .\models\chair.obj
    expect((ok(piece(1, {}, { model: ".\\\\models\\\\chair.obj" }))[0] as ImportedPiece).modelFile).toBe(
      "models/chair.obj",
    );
    expect(fail(piece(1, {}, { model: "?id=5" }))).toBe("model#1: query references are not supported: ?id=5");
    expect(fail(piece(1, {}, { icon: "pack.zip!/icon.png" }))).toBe(
      "icon#1: archive-entry references are not supported: pack.zip!/icon.png",
    );
  });

  it("C-025 declared digests are carried but never trusted; malformed base64 warns and is dropped", () => {
    const r = importFlatCatalog(piece(1, { modelDigest: "AQID", iconDigest: "not base64!" }), opts);
    if (!r.ok) throw new Error(r.error);
    expect(r.items[0]?.declaredDigests).toEqual({ modelDigest: "AQID" });
    expect(r.warnings).toEqual(["iconDigest#1: malformed base64 digest ignored"]);
  });

  it("C-026 (reversed) two pieces with the same explicit id are an error; derived ids get a suffix", () => {
    expect(fail(`${piece(1, { id: "chest" })}\n${piece(2, { id: "Chest" })}`)).toBe(
      "id#2: duplicate id chest",
    );
    const items = ok(`${piece(1, {}, { name: "Chest" })}\n${piece(2, {}, { name: "Chest" })}`);
    expect(items.map((p) => p.product.id)).toEqual(["acme-lib-chest", "acme-lib-chest-2"]);
  });

  it("C-034 C-035 a localised file overrides names only; dimensions stay those of the base file", () => {
    const fr = [piece(1, {}, { name: "Chaise", width: "999" })].join("\n");
    const [p] = ok(piece(1, {}, { name: "Chair" }), { ...opts, localized: { fr } });
    expect((p as ImportedPiece).product.name).toBe("Chair");
    expect((p as ImportedPiece).localizedNames).toEqual({ fr: "Chaise" });
    expect((p as ImportedPiece).product.dims.w).toBe(600);
  });
});

describe("door fields (O-007..O-013, C-010, C-011)", () => {
  const door = (extra: Record<string, string> = {}, base: Record<string, string> = {}) =>
    piece(1, extra, { doorOrWindow: "true", width: "91", depth: "34", height: "209", ...base });
  const spec = (text: string, o = opts) => {
    const [p] = ok(text, o);
    return (p as ImportedPiece).product;
  };

  it("O-007 C-010 wall thickness is cm over depth, defaulting to the whole depth", () => {
    expect(spec(door({ doorOrWindowWallThickness: "25" })).opening?.embed.thickness).toBeCloseTo(
      0.7352941,
      6,
    );
    expect(spec(door()).opening?.embed.thickness).toBe(1);
  });

  it("O-008 wall distance defaults to zero, else cm over depth", () => {
    expect(spec(door()).opening?.embed.distance).toBe(0);
    expect(spec(door({ doorOrWindowWallDistance: "1" })).opening?.embed.distance).toBeCloseTo(1 / 34, 6);
  });

  it("O-009 C-011 cutting both sides defaults to true with one default everywhere", () => {
    expect(spec(door()).opening?.cutBothSides).toBe(true);
    expect(spec(door({ doorOrWindowWallCutOutOnBothSides: "false" })).opening?.cutBothSides).toBe(false);
  });

  it("O-010 width and depth deformability defaults to true at product level", () => {
    expect(spec(door()).deformable).toBe(true);
    expect(spec(door({ doorOrWindowWidthDepthDeformable: "false" })).deformable).toBe(false);
  });

  it("O-011 (reversed) no cut-out shape means null, and null means the rectangle, never a mesh projection", () => {
    expect(spec(door()).opening?.cutOutPath).toBeNull();
    expect(spec(door({ doorOrWindowCutOutShape: "M0,0 v1 h1 v-1 z" })).opening?.cutOutPath).toBe(
      "M0,0 v1 h1 v-1 z",
    );
  });

  it("O-012 a user-imported door is forced to both sides, deformable and no cut-out shape", () => {
    const p = spec(
      door({
        doorOrWindowWallCutOutOnBothSides: "false",
        doorOrWindowWidthDepthDeformable: "false",
        doorOrWindowCutOutShape: "M0,0 v1 h1 v-1 z",
      }),
      { ...opts, source: "user" },
    );
    expect(p.opening?.cutBothSides).toBe(true);
    expect(p.deformable).toBe(true);
    expect(p.opening?.cutOutPath).toBeNull();
  });

  it("O-013 every door piece is an opening product: wall mount only, no drop surface, valid as such", () => {
    const p = spec(door({ horizontallyRotatable: "true", movable: "true" }));
    expect(p.category).toBe("door");
    expect(p.mount.kinds).toEqual(["wall"]);
    expect(p.mountPoints).toEqual([]);
    expect(validateProduct(p).filter((x) => x.severity === "error")).toEqual([]);
  });
});

describe("flat texture catalogs (C-040)", () => {
  const tex = (i: number, over: Record<string, string> = {}) =>
    Object.entries({
      name: `Tex ${i}`,
      category: "Wall",
      image: `t${i}.png`,
      width: "20",
      height: "30",
      ...over,
    })
      .map(([k, v]) => `${k}#${i}=${v}`)
      .join("\n");

  it("C-040 name, category, image, width and height are mandatory; scan rules match pieces", () => {
    const r = importFlatTextures(
      `${tex(1)}\n${tex(2, { ignored: "false" })}\n${tex(3, { ignored: "true" })}\n${tex(4)}`,
      opts,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.items.map((t) => t.id)).toEqual(["acme-lib/tex-1", "acme-lib/tex-2", "acme-lib/tex-4"]);
    expect(r.items[0]).toMatchObject({ imageFile: "t1.png", widthMm: 200, heightMm: 300, creator: null });
    const bad = importFlatTextures(tex(1).replace(/image#1=t1.png\n?/, ""), opts);
    expect(bad).toEqual({ ok: false, error: "missing mandatory key image#1" });
  });
});
