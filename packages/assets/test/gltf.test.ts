// glTF models for the catalog (ADR-010 D3, D10; P3-8): read, measured, refused for what the viewer could
// not draw, and normalised so the model stands on the floor, centred, in metres, facing the right way.
import { describe, expect, it } from "vitest";
import { describeModel, GltfError, measureGltf, prepareModel, readGlb } from "../src/index.js";
import { boxGlb } from "./glb-maker.js";

const codeOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof GltfError) return e.code;
    throw e;
  }
  return "read";
};
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe("reading a binary glTF", () => {
  it("measures what its scene draws, through each node's transform, and counts its triangles", () => {
    const glb = boxGlb([
      { min: [0, 0, 0], max: [1, 2, 3], material: "fabric" },
      { min: [0, 0, 0], max: [1, 1, 1], node: { translation: [4, 0, 0], scale: [2, 2, 2] } },
    ]);
    const { json, bin } = readGlb(glb);
    const m = measureGltf(json, bin);
    expect(m.min).toEqual([0, 0, 0]);
    expect(m.max).toEqual([6, 2, 3]);
    expect(m.triangles).toBe(24);
    expect(m.exact).toBe(true);
  });

  it("measures a turned part through its node; with no points to read, its declared bounds stand in, and it says so", () => {
    // a 1 m cube turned 45 degrees about y: its footprint is the diagonal, not 1.41 times it
    const s = Math.SQRT1_2;
    const glb = boxGlb([{ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5], node: { rotation: [0, s, 0, s] } }]);
    const turned = describeModel(glb);
    close(turned.size.w, 1);
    const eighth = Math.sin(Math.PI / 8);
    const tilted = describeModel(
      boxGlb([
        {
          min: [-0.5, 0, -0.5],
          max: [0.5, 1, 0.5],
          node: { rotation: [0, eighth, 0, Math.cos(Math.PI / 8)] },
        },
      ]),
    );
    close(tilted.size.w, Math.SQRT2);
    expect(tilted.exact).toBe(true);
    // with no points to read, the declared bounds stand in, and the result says so
    const bounds = describeModel(
      boxGlb(
        [
          {
            min: [-0.5, 0, -0.5],
            max: [0.5, 1, 0.5],
            node: { rotation: [0, eighth, 0, Math.cos(Math.PI / 8)] },
          },
        ],
        {
          boundsOnly: true,
        },
      ),
    );
    expect(bounds.exact).toBe(false);
    close(bounds.size.w, Math.SQRT2);
  });

  it("reads data written into the file as a data URI", () => {
    const m = describeModel(boxGlb([{ min: [0, 0, 0], max: [2, 1, 0.5] }], { dataUri: true }));
    expect(m.size).toEqual({ w: 2, d: 0.5, h: 1 });
    expect(m.exact).toBe(true);
  });

  it("says what is wrong with a file it cannot use, and what to do instead", () => {
    const ok = boxGlb([{ min: [0, 0, 0], max: [1, 1, 1] }]);
    expect(codeOf(() => readGlb(new TextEncoder().encode('  {"asset":{"version":"2.0"}}')))).toBe(
      "model.gltf-text",
    );
    expect(codeOf(() => readGlb(new TextEncoder().encode("solid cube\nfacet normal 0 0 1")))).toBe(
      "model.not-glb",
    );
    const v1 = ok.slice();
    new DataView(v1.buffer).setUint32(4, 1, true);
    expect(codeOf(() => readGlb(v1))).toBe("model.version");
    expect(codeOf(() => readGlb(ok.subarray(0, ok.length - 8)))).toBe("model.corrupt");
    expect(
      codeOf(() =>
        describeModel(
          boxGlb([{ min: [0, 0, 0], max: [1, 1, 1] }], {
            extensionsRequired: ["KHR_draco_mesh_compression"],
          }),
        ),
      ),
    ).toBe("model.draco");
    expect(
      codeOf(() =>
        describeModel(
          boxGlb([{ min: [0, 0, 0], max: [1, 1, 1] }], { extensionsRequired: ["KHR_texture_basisu"] }),
        ),
      ),
    ).toBe("model.extension");
    expect(
      codeOf(() =>
        describeModel(boxGlb([{ min: [0, 0, 0], max: [1, 1, 1] }], { externalImage: "wood.png" })),
      ),
    ).toBe("model.external");
    expect(codeOf(() => describeModel(boxGlb([])))).toBe("model.empty");
    // what the viewer's loader decodes is fine to require
    expect(
      describeModel(
        boxGlb([{ min: [0, 0, 0], max: [1, 1, 1] }], { extensionsRequired: ["KHR_mesh_quantization"] }),
      ).triangles,
    ).toBe(12);
  });
});

describe("normalising a model for the catalog", () => {
  it("stands it on the floor with its footprint centred, keeping its data byte for byte", () => {
    const glb = boxGlb([{ min: [3, 5, -2], max: [4.2, 5.9, -1.5], material: "body" }]);
    const prepared = prepareModel(glb);
    expect(prepared.size.w).toBeCloseTo(1.2, 6);
    expect(prepared.size.h).toBeCloseTo(0.9, 6);
    expect(prepared.size.d).toBeCloseTo(0.5, 6);
    const again = readGlb(prepared.bytes);
    const m = measureGltf(again.json, again.bin);
    close(m.min[1], 0);
    close((m.min[0] + m.max[0]) / 2, 0);
    close((m.min[2] + m.max[2]) / 2, 0);
    expect([...(again.bin ?? [])]).toEqual([...(readGlb(glb).bin ?? [])]);
    // one root holds the scene; what was there is under it, untouched
    const root = again.json.scenes?.[0]?.nodes ?? [];
    expect(root).toHaveLength(1);
    expect(again.json.nodes?.[root[0] as number]?.children).toEqual([0]);
  });

  it("turns it about the vertical in quarter turns, stands it up, and scales it from its units", () => {
    const glb = boxGlb([{ min: [0, 0, 0], max: [200, 50, 100] }]); // centimetres, made with z up
    const plain = prepareModel(glb, { metresPerUnit: 0.01 });
    expect(plain.size).toEqual({ w: 2, d: 1, h: 0.5 });
    const turned = prepareModel(glb, { metresPerUnit: 0.01, turn: 1 });
    expect(turned.size.w).toBeCloseTo(1, 9);
    expect(turned.size.d).toBeCloseTo(2, 9);
    // one step about x stands a z-up model on its base: its depth becomes its height
    const stood = prepareModel(glb, { metresPerUnit: 0.01, tip: 1 });
    expect(stood.size.h).toBeCloseTo(1, 9);
    expect(stood.size.d).toBeCloseTo(0.5, 9);
    // a quarter turn is exact: no 6e-17 rides into the file
    const root = readGlb(turned.bytes).json.nodes?.at(-1)?.matrix ?? [];
    expect(root.some((v) => v !== 0 && Math.abs(v) < 1e-9)).toBe(false);
    expect(() => prepareModel(glb, { metresPerUnit: 0 })).toThrow(GltfError);
  });

  it("names every material, so each part can be chosen, and keeps names unique", () => {
    const glb = boxGlb([
      { min: [0, 0, 0], max: [1, 1, 1], material: "Fabric" },
      { min: [0, 0, 0], max: [1, 1, 1], material: null },
      { min: [0, 0, 0], max: [1, 1, 1], material: "material-2" },
    ]);
    const prepared = prepareModel(glb);
    expect(prepared.slots).toEqual(["Fabric", "material-2", "material-2-2"]);
    expect(describeModel(prepared.bytes).slots).toEqual(prepared.slots);
  });

  it("gives the same model the same bytes, and a normalised one comes through unchanged in size", () => {
    const glb = boxGlb([{ min: [0, 0, 0], max: [1, 2, 3] }]);
    const a = prepareModel(glb, { turn: 2 });
    const b = prepareModel(glb, { turn: 2 });
    expect([...a.bytes]).toEqual([...b.bytes]);
    const twice = prepareModel(a.bytes);
    expect(twice.size).toEqual(a.size);
    // a flat sheet still gets a millimetre of thickness, as any product side does
    expect(prepareModel(boxGlb([{ min: [0, 0, 0], max: [1, 0, 1] }])).size.h).toBe(0.001);
  });
});
