import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, type Ctx, type RenderRequestMsg } from "@fpv/commands";
import { Project, type Project as ProjectT, sequentialIdGenerator } from "@fpv/ir";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { camerasFor, focusBounds, renderViews, SceneBinding } from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = (): ProjectT => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));
const ctx: Ctx = { ids: sequentialIdGenerator(900), now: () => "2026-09-15T00:00:00.000Z" };
const L = "level_000000";

function withRoom(): ProjectT {
  const r = apply(
    fixture(),
    { type: "room.create", payload: { levelId: L, atPoint: { x: 2000, y: 2000 } } },
    ctx,
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

const req = (over: Partial<RenderRequestMsg>): RenderRequestMsg => ({
  type: "render.request",
  requestId: "r1",
  views: [{ name: "room" }],
  hideWalls: false,
  focusId: null,
  width: 400,
  ...over,
});

describe("render views (spec 04 render, ADR-005 D6)", () => {
  it("overhead gives four corner cameras looking down at the target from above", () => {
    const target = new THREE.Box3(new THREE.Vector3(0, 0, -5), new THREE.Vector3(8, 2.7, 0));
    const cams = camerasFor("overhead", target, 4 / 3);
    expect(cams.map((c) => c.name)).toEqual(["overhead-ne", "overhead-nw", "overhead-se", "overhead-sw"]);
    for (const { camera } of cams) {
      expect(camera.position.y).toBeGreaterThan(2.7);
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      expect(dir.y).toBeLessThan(-0.3); // looking down
    }
    const [ne, nw] = cams;
    expect((ne as (typeof cams)[number]).camera.position.x).toBeGreaterThan(
      (nw as (typeof cams)[number]).camera.position.x,
    );
  });

  it("plan is an orthographic top-down camera covering the target with +y up the image", () => {
    const target = new THREE.Box3(new THREE.Vector3(0, 0, -5), new THREE.Vector3(8, 2.7, 0));
    const [plan] = camerasFor("plan", target, 2);
    const cam = plan?.camera as THREE.OrthographicCamera;
    expect(cam).toBeInstanceOf(THREE.OrthographicCamera);
    expect(cam.right - cam.left).toBeGreaterThanOrEqual(8);
    expect((cam.right - cam.left) / (cam.top - cam.bottom)).toBeCloseTo(2, 6);
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    expect(dir.y).toBeCloseTo(-1, 6);
    // a point north of the centre (more negative z) projects higher in the image
    const north = new THREE.Vector3(4, 0, -4).project(cam);
    const south = new THREE.Vector3(4, 0, -1).project(cam);
    expect(north.y).toBeGreaterThan(south.y);
  });

  it("eye stands at 1.6 m inside the target; room is a three-quarter view", () => {
    const target = new THREE.Box3(new THREE.Vector3(0, 0, -5), new THREE.Vector3(8, 2.7, 0));
    const [eye] = camerasFor("eye", target, 4 / 3);
    expect(eye?.camera.position.y).toBeCloseTo(1.6, 6);
    expect(target.containsPoint(eye?.camera.position as THREE.Vector3)).toBe(true);
    const [room] = camerasFor("room", target, 4 / 3);
    expect(room?.name).toBe("room");
    expect(room?.camera.position.y).toBeGreaterThan(2.7);
  });

  it("focusBounds resolves rooms and items; unknown ids fall back to the scene bounds", () => {
    const p = withRoom();
    const room = focusBounds(p, p.rooms[0]?.id as string) as THREE.Box3;
    expect(room.min.x).toBeCloseTo(0.05, 6);
    expect(room.max.x).toBeCloseTo(7.95, 6);
    expect(room.max.y).toBeCloseTo(2.7, 6);
    expect(room.min.z).toBeCloseTo(-4.95, 6);
    expect(focusBounds(p, "room_zzzzzz")).toBeNull();
    expect(focusBounds(p, null)).toBeNull();
  });

  it("renderViews hides walls and ceilings only while capturing and returns one image per view", async () => {
    const b = new SceneBinding();
    const p = withRoom();
    b.setProject(p);
    const seen: { name: string; wallsVisible: boolean; ceilingVisible: boolean }[] = [];
    const ceiling = b.rooms.children.find(
      (o) => (o.userData as { part: string }).part === "ceiling",
    ) as THREE.Object3D;
    const capture = async (_cam: THREE.Camera, name: string) => {
      seen.push({
        name,
        wallsVisible: b.walls.children.every((o) => o.visible),
        ceilingVisible: ceiling.visible,
      });
      return "AAAA";
    };
    const images = await renderViews(
      b,
      p,
      req({
        views: ["overhead-ne", "overhead-nw", "overhead-se", "overhead-sw"].map((name) => ({ name })),
        hideWalls: true,
      }),
      capture,
    );
    expect(images).toHaveLength(4);
    expect(images[0]).toMatchObject({ view: "overhead-ne", width: 400, height: 300, pngBase64: "AAAA" });
    expect(seen.every((s) => !s.wallsVisible && !s.ceilingVisible)).toBe(true);
    expect(b.walls.children.every((o) => o.visible)).toBe(true);
    expect(ceiling.visible).toBe(true);
    const single = await renderViews(
      b,
      p,
      req({ views: [{ name: "eye" }], focusId: p.rooms[0]?.id as string }),
      capture,
    );
    expect(single.map((i) => i.view)).toEqual(["eye"]);
    expect(seen.at(-1)?.wallsVisible).toBe(true);
  });

  it("a capture failure still restores visibility", async () => {
    const b = new SceneBinding();
    b.setProject(fixture());
    await expect(
      renderViews(b, null, req({ hideWalls: true }), async () => Promise.reject(new Error("gpu lost"))),
    ).rejects.toThrow("gpu lost");
    expect(b.walls.children.every((o) => o.visible)).toBe(true);
  });
});
