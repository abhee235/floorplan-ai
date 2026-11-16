// Texture images and the texture list (P3-5): drawn textures are rendered on request, library textures are
// read from the installed copy, the viewer gets both over HTTP, and a finish that names one copies it into
// the project through the real catalog.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSeed } from "@fpv/catalog";
import { CatalogStore, installLibraryDir } from "@fpv/catalog/store";
import { Project, sequentialIdGenerator } from "@fpv/ir";
import { afterEach, describe, expect, it } from "vitest";
import { createSession, type Served, serve } from "../src/index.js";
import { TextureImages } from "../src/textures.js";

const NOW = "2026-09-17T12:00:00.000Z";
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));
const fixture = () => Project.parse(JSON.parse(readFileSync(`${fixtureDir}project.json`, "utf8")));

const temps: string[] = [];
let served: Served | null = null;
const stores: CatalogStore[] = [];
afterEach(async () => {
  await served?.close();
  served = null;
  for (const s of stores.splice(0)) s.close();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function catalog(): { store: CatalogStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fpv-textures-"));
  temps.push(dir);
  const store = CatalogStore.open(":memory:");
  stores.push(store);
  ensureSeed(store, NOW);
  return { store, dir };
}

describe("texture images (P3-5)", () => {
  it("draws a built-in texture as a PNG once, and knows nothing of a texture it does not have", () => {
    const { store, dir } = catalog();
    const images = new TextureImages(store, dir);
    const oak = images.image("generated/oak");
    expect(oak?.type).toBe("image/png");
    expect([...(oak?.bytes.subarray(0, 8) ?? [])]).toEqual(PNG);
    expect(images.image("generated/oak")).toBe(oak);
    expect(images.image("generated/marble")).toBeNull();
  });

  it("reads a library's texture from the copy its install made", () => {
    const { store, dir } = catalog();
    const source = mkdtempSync(join(tmpdir(), "fpv-texlib-"));
    temps.push(source);
    const bytes = Buffer.from([...PNG, 1, 2, 3]);
    const hex = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(join(source, "textures"));
    writeFileSync(join(source, "textures", `${hex}.png`), bytes);
    const licence = { id: "own", author: null, sourceUrl: null, attribution: null };
    writeFileSync(
      join(source, "library.json"),
      JSON.stringify({
        id: "acme",
        name: "Acme",
        version: "1.0.0",
        licence,
        provider: null,
        products: [],
        textures: [
          {
            id: "acme/stone",
            name: "Stone",
            image: `sha256:${hex}`,
            widthMm: 400,
            heightMm: 400,
            licence,
            tags: [],
          },
        ],
        assets: { version: 1, entries: [] },
        localized: {},
      }),
    );
    installLibraryDir(store, source, dir, NOW);
    const image = new TextureImages(store, dir).image("acme/stone");
    expect(image?.type).toBe("image/png");
    expect(Buffer.from(image?.bytes ?? []).equals(bytes)).toBe(true);
  });

  it("serves texture images over HTTP, lists the textures over the bridge, and snapshots one a finish uses", async () => {
    const { store, dir } = catalog();
    const images = new TextureImages(store, dir);
    const session = createSession({
      project: fixture(),
      ids: sequentialIdGenerator(900),
      now: () => NOW,
      catalog: store,
    });
    served = await serve(session, { port: 0, textures: (id) => images.image(id) });
    const base = `http://127.0.0.1:${served.port}`;
    const ok = await fetch(`${base}/textures/generated/oak`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await ok.arrayBuffer()).subarray(0, 8)]).toEqual(PNG);
    expect((await fetch(`${base}/textures/generated/marble`)).status).toBe(404);
    expect((await fetch(`${base}/textures/..%2F..%2Fpackage.json`)).status).toBe(404);

    const ws = new WebSocket(`ws://127.0.0.1:${served.port}/bridge`);
    const replies = new Map<string, (m: Record<string, unknown>) => void>();
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
      replies.get(m.id as string)?.(m);
    };
    await new Promise((r) => {
      ws.onopen = r;
    });
    const ask = (id: string, body: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        replies.set(id, resolve);
        ws.send(JSON.stringify({ id, ...body }));
      });
    await ask("h", { type: "hello", clientVersion: "t", capabilities: [] });
    const listed = await ask("t", { type: "get", what: "textures" });
    const textures = (listed.result as { textures: { id: string; widthMm: number }[] }).textures;
    expect(textures.find((t) => t.id === "generated/oak")).toMatchObject({
      name: "Oak planks",
      widthMm: 880,
    });
    ws.close();

    const finish = {
      color: null,
      textureId: "generated/brick-red",
      placement: null,
      mirrorForLeftSide: false,
      shininess: null,
    };
    const r = session.store.apply({
      type: "wall.modify",
      payload: { wallId: "wall_000001", changes: { finishes: { left: finish, right: null, top: null } } },
    });
    expect(r.ok).toBe(true);
    expect(session.store.project.textures["generated/brick-red"]).toMatchObject({
      widthMm: 450,
      heightMm: 300,
    });
  });
});
