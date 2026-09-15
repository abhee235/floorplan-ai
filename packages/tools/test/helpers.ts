import { createStore } from "@fpv/commands";
import { type Project, sequentialIdGenerator } from "@fpv/ir";
import {
  blankProject,
  type CatalogProduct,
  catalogSourceOf,
  createRegistry,
  createTranscript,
  memoryCatalog,
  type Registry,
  type ToolContext,
  type ToolOk,
  type ToolResult,
  type Transcript,
} from "../src/index.js";

export const NOW = "2026-09-15T12:00:00.000Z";

export const PRODUCTS: CatalogProduct[] = [
  {
    id: "acme-boardroom-3600",
    make: "Acme",
    model: "Boardroom 3600",
    name: "Acme Boardroom table 3600",
    category: "table",
    dims: { w: 3600, d: 1400, h: 750 },
    status: "verified",
    price: 2400,
    tags: ["boardroom", "table"],
  },
  {
    id: "acme-task-chair",
    make: "Acme",
    model: "Task",
    name: "Acme task chair",
    category: "chair",
    dims: { w: 600, d: 600, h: 900 },
    status: "verified",
    price: 180,
  },
  {
    id: "viewco-qm75",
    make: "ViewCo",
    model: "QM75",
    name: "ViewCo QM75 75 inch display",
    category: "display",
    dims: { w: 1670, d: 60, h: 960 },
    status: "unverified",
  },
];

export interface Harness {
  registry: Registry;
  ctx: ToolContext;
  transcript: Transcript;
  call<T = unknown>(name: string, args?: unknown): Promise<ToolResult<T>>;
  ok<T = unknown>(name: string, args?: unknown): Promise<ToolOk<T>>;
}

export function harness(project?: Project, options: Partial<ToolContext> = {}): Harness {
  const now = () => NOW;
  const catalog = options.catalog ?? memoryCatalog(PRODUCTS);
  const ids = sequentialIdGenerator(1);
  const store = createStore(project ?? blankProject("Test", NOW), {
    ids,
    now,
    catalog: catalogSourceOf(catalog, now),
  });
  const transcript = createTranscript();
  const ctx: ToolContext = {
    store,
    catalog,
    viewer: null,
    files: null,
    verifier: null,
    rules: null,
    writer: null,
    transcript,
    now,
    ...options,
  };
  const registry = createRegistry(ctx);
  const call = <T>(name: string, args: unknown = {}) => registry.call(name, args) as Promise<ToolResult<T>>;
  return {
    registry,
    ctx,
    transcript,
    call,
    async ok<T>(name: string, args: unknown = {}) {
      const r = await call<T>(name, args);
      if (!r.ok)
        throw new Error(
          `${name}: ${r.error.code}: ${r.error.message}${r.error.hint ? ` (hint: ${r.error.hint})` : ""}`,
        );
      return r;
    },
  };
}

/** The six-wall fixture room, built by tool calls alone (PRD P0-6 acceptance). */
export async function buildFixtureRoom(h: Harness): Promise<{ roomId: string }> {
  await h.ok("create_walls", {
    levelId: "level_000000",
    points: [
      { x: 0, y: 0 },
      { x: 8000, y: 0 },
      { x: 8000, y: 3000 },
      { x: 5000, y: 3000 },
      { x: 5000, y: 5000 },
      { x: 0, y: 5000 },
    ],
    closed: true,
    thickness: 100,
    kind: "interior",
  });
  await h.ok("add_opening", {
    wallId: "wall_000001",
    kind: "door",
    position: 0.5,
    hingeSide: "west",
    swingDirection: "left",
  });
  const room = await h.ok<{ room: { id: string } }>("create_room", {
    levelId: "level_000000",
    atPoint: { x: 2000, y: 2000 },
    name: "Boardroom",
    purpose: "boardroom",
    capacity: 10,
  });
  return { roomId: room.result.room.id };
}
