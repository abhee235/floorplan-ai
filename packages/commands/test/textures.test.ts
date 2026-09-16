// A finish that names a texture copies the texture's record into the project on first use (spec 02
// section 2, P3-5), as a product is copied into catalogRefs; a texture the catalog does not have is refused.
import { validate } from "@fpv/ir";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../src/index.js";
import { BOX, ctx, fail, fixture, LEVEL, ok } from "./helpers.js";

const OAK = {
  id: "generated/oak",
  name: "Oak planks",
  image: "generated:oak",
  widthMm: 880,
  heightMm: 1800,
  transparent: false,
  creator: null,
  licence: { id: "generated", author: null, sourceUrl: null, attribution: null },
  tags: ["wood"],
};
const base = ctx(800);
const c: Ctx = {
  ...base,
  catalog: { product: () => null, texture: (id) => (id === OAK.id ? OAK : null) },
};
const finish = (textureId: string | null) => ({
  color: null,
  textureId,
  placement: null,
  mirrorForLeftSide: false,
  shininess: null,
});

describe("textures in finishes (P3-5)", () => {
  it("copies a texture into the project the first time a wall side uses it, and validates", () => {
    const p = fixture();
    expect(p.textures).toEqual({});
    const r = ok(
      p,
      {
        type: "wall.modify",
        payload: {
          wallId: "wall_000001",
          changes: { finishes: { left: finish(OAK.id), right: null, top: null } },
        },
      },
      c,
    );
    expect(r.project.textures[OAK.id]).toMatchObject({ id: OAK.id, widthMm: 880, image: "generated:oak" });
    expect(validate(r.project).filter((x) => x.severity === "error")).toEqual([]);
  });

  it("does the same for a floor and an item's part, and keeps the copy it already has", () => {
    const room = ok(
      fixture(),
      { type: "room.create", payload: { levelId: LEVEL, atPoint: { x: 2000, y: 2000 } } },
      c,
    );
    const roomId = room.project.rooms[0]?.id as string;
    const floored = ok(
      room.project,
      {
        type: "room.modify",
        payload: { roomId, changes: { finishes: { floor: finish(OAK.id), ceiling: null } } },
      },
      c,
    );
    expect(Object.keys(floored.project.textures)).toEqual([OAK.id]);
    const placed = ok(
      floored.project,
      { type: "item.place", payload: { levelId: LEVEL, ref: BOX, position: { x: 1000, y: 1000 } } },
      c,
    );
    const itemId = placed.project.items[0]?.id as string;
    // a catalog that has since lost the texture does not matter: the project's copy is used
    const forgetful: Ctx = { ...c, catalog: { product: () => null, texture: () => null } };
    const dressed = ok(
      placed.project,
      { type: "item.setFinish", payload: { itemIds: [itemId], materials: { body: finish(OAK.id) } } },
      forgetful,
    );
    expect(dressed.project.items[0]?.materials.body?.textureId).toBe(OAK.id);
  });

  it("refuses a texture the catalog does not have, changing nothing", () => {
    const p = fixture();
    const r = fail(
      p,
      {
        type: "wall.modify",
        payload: {
          wallId: "wall_000001",
          changes: { finishes: { left: finish("generated/marble"), right: null, top: null } },
        },
      },
      c,
    );
    expect(r.error.code).toBe("catalog.missing-texture");
    expect(r.error.hint).toContain("catalog");
    // and a catalog with no textures at all refuses the same way
    expect(
      fail(
        p,
        {
          type: "wall.modify",
          payload: {
            wallId: "wall_000001",
            changes: { finishes: { left: finish(OAK.id), right: null, top: null } },
          },
        },
        base,
      ).error.code,
    ).toBe("catalog.missing-texture");
  });
});
