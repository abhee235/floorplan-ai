// Model assets in the viewer (ADR-003 D5, ADR-010 D5, PRD P3-8): which models the host has, and each
// one loaded once and shared by every item drawn from it. No loader here, so the binding's tests run in
// Node; the browser's glTF loader is in model-loader.ts and handed in.
import type { AssetRegistry } from "@fpv/engine";
import type * as THREE from "three";

/** A model the host serves at /models/<key>, as the bridge lists it. */
export interface ModelEntry {
  key: string;
  /** Metres, after normalisation: the box the model fills, which an item's size scales from. */
  bbox: { w: number; d: number; h: number };
  materialSlots: string[];
  /** Tells two files under one key apart, after a library update. */
  sha256: string | null;
}

/** The models the catalog has, as the engine asks about them. */
export class ModelRegistry implements AssetRegistry {
  private entries = new Map<string, ModelEntry>();

  /** Replace the list; returns the keys whose file changed or went, which a cache must load again. */
  set(list: readonly ModelEntry[]): string[] {
    const next = new Map(list.map((e) => [e.key, e]));
    const stale = [...this.entries.values()]
      .filter((e) => next.get(e.key)?.sha256 !== e.sha256)
      .map((e) => e.key);
    this.entries = next;
    return stale;
  }

  entry(key: string): ModelEntry | null {
    return this.entries.get(key) ?? null;
  }

  keyFor(): string | null {
    // a product names its model in its snapshot; the engine reads it there and asks bbox to confirm
    return null;
  }

  bbox(key: string): { w: number; d: number; h: number } | null {
    return this.entries.get(key)?.bbox ?? null;
  }

  slots(key: string): readonly string[] | null {
    return this.entries.get(key)?.materialSlots ?? null;
  }
}

/**
 * Whether a project names a model this tab has not been told of: one imported in another tab, or by the
 * agent, after the tab asked for the list. Each key is looked at once, so a key that is not a model at
 * all (a recipe's) does not make the tab ask on every change.
 */
export function namesUnknownModel(
  catalogRefs: Record<string, unknown>,
  seen: Set<string>,
  registry: Pick<ModelRegistry, "entry">,
): boolean {
  let unknown = false;
  for (const snap of Object.values(catalogRefs)) {
    const key = (snap as { assetKey?: unknown } | null)?.assetKey;
    if (typeof key !== "string" || seen.has(key)) continue;
    seen.add(key);
    if (!registry.entry(key)) unknown = true;
  }
  return unknown;
}

/** Load one model's scene by key; the version tells a cache-busting URL which file it wants. */
export type ModelLoad = (key: string, version: string | null) => Promise<THREE.Object3D>;

export type ModelState =
  | { status: "loading" }
  | { status: "ready"; template: THREE.Object3D }
  | { status: "failed"; reason: string };

/** What the binding asks of the models: how one stands, and to hear when one settles. */
export interface ModelSource {
  state(key: string): ModelState;
  onSettled(listener: (key: string) => void): () => void;
}

/**
 * Each model loaded once, on first ask, and kept as a template the binding clones per item: geometry and
 * materials are shared, so a hundred chairs cost one chair's memory.
 */
export class ModelCache implements ModelSource {
  private readonly states = new Map<string, ModelState>();
  private readonly listeners = new Set<(key: string) => void>();
  private disposed = false;

  constructor(
    private readonly load: ModelLoad,
    private readonly versionOf: (key: string) => string | null = () => null,
  ) {}

  state(key: string): ModelState {
    const known = this.states.get(key);
    if (known) return known;
    const loading: ModelState = { status: "loading" };
    this.states.set(key, loading);
    this.load(key, this.versionOf(key)).then(
      (template) => this.settle(key, loading, { status: "ready", template }),
      (e: unknown) =>
        this.settle(key, loading, { status: "failed", reason: e instanceof Error ? e.message : String(e) }),
    );
    return loading;
  }

  onSettled(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Load these again on next ask: their file changed, or they are gone. */
  forget(keys: readonly string[]): void {
    for (const key of keys) {
      const s = this.states.get(key);
      if (s?.status === "ready") release(s.template);
      this.states.delete(key);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.forget([...this.states.keys()]);
    this.listeners.clear();
  }

  private settle(key: string, from: ModelState, to: ModelState): void {
    // forgotten or replaced while it loaded: what arrived is for nobody
    if (this.disposed || this.states.get(key) !== from) {
      if (to.status === "ready") release(to.template);
      return;
    }
    this.states.set(key, to);
    for (const l of this.listeners) l(key);
  }
}

/** Free a template's geometry, materials and textures. */
function release(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of materials) {
      for (const value of Object.values(m))
        if ((value as THREE.Texture)?.isTexture) (value as THREE.Texture).dispose();
      m.dispose();
    }
  });
}
