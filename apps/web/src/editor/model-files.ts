// The files a person chose to import as a model (ADR-010 D10, PRD P3-8), read in the browser: a .glb as it
// is, or a .gltf together with the .bin and pictures it names, loaded with three.js's own loader and written
// out as one .glb, which is all the host takes. The scene read here is the dialog's preview.
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { gltfLoader } from "../viewer/model-loader.js";
import type { Extent } from "./model-import.js";

export interface PickedModel {
  /** The file the person chose: the .glb, or the .gltf. */
  fileName: string;
  /** What is sent to the host: the .glb as chosen, or the .gltf written out as one. */
  bytes: Uint8Array;
  scene: THREE.Object3D;
  /** In the file's own units, as the file is. */
  extent: Extent;
  /** True when a .gltf and its files were written out as one .glb here. */
  converted: boolean;
}

const nameOf = (url: string) => decodeURIComponent(url.split(/[\\/]/).pop()?.split("?")[0] ?? "");

/** Read the chosen files. Throws an Error whose message says, in a person's words, what is wrong. */
export async function readModelFiles(files: readonly File[]): Promise<PickedModel> {
  const glb = files.find((f) => /\.glb$/i.test(f.name));
  const gltf = files.find((f) => /\.gltf$/i.test(f.name));
  if (glb && !gltf) {
    const buffer = await glb.arrayBuffer();
    const read = await gltfLoader()
      .parseAsync(buffer, "")
      .catch((e: unknown) => {
        throw new Error(`${glb.name} could not be read as a glTF model: ${messageOf(e)}`);
      });
    return {
      fileName: glb.name,
      bytes: new Uint8Array(buffer),
      scene: read.scene,
      extent: extentOf(read.scene),
      converted: false,
    };
  }
  if (!gltf) throw new Error("Choose a .glb file, or a .gltf together with its .bin and texture files.");
  // the .gltf names its other files; each is found among the chosen ones by its name
  const urls = new Map(files.map((f) => [f.name, URL.createObjectURL(f)]));
  const missing = new Set<string>();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith("data:") || [...urls.values()].includes(url)) return url;
    const found = urls.get(nameOf(url));
    if (!found) missing.add(nameOf(url));
    return found ?? url;
  });
  try {
    const read = await gltfLoader(manager)
      .loadAsync(urls.get(gltf.name) as string)
      .catch((e: unknown) => {
        throw new Error(
          missing.size > 0
            ? `${gltf.name} needs ${[...missing].join(", ")}, which ${missing.size > 1 ? "were" : "was"} not chosen with it.`
            : `${gltf.name} could not be read as a glTF model: ${messageOf(e)}`,
        );
      });
    if (missing.size > 0)
      throw new Error(
        `${gltf.name} needs ${[...missing].join(", ")}, which ${missing.size > 1 ? "were" : "was"} not chosen with it.`,
      );
    const written = await new GLTFExporter().parseAsync(read.scene, { binary: true });
    if (!(written instanceof ArrayBuffer)) throw new Error(`${gltf.name} could not be written as one .glb.`);
    return {
      fileName: gltf.name,
      bytes: new Uint8Array(written),
      scene: read.scene,
      extent: extentOf(read.scene),
      converted: true,
    };
  } finally {
    for (const url of urls.values()) URL.revokeObjectURL(url);
  }
}

/** The scene's extent from its points, as the host measures it: x across, y up, z toward its front. */
export function extentOf(scene: THREE.Object3D): Extent {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene, true);
  if (box.isEmpty()) return { w: 0, d: 0, h: 0 };
  const size = box.getSize(new THREE.Vector3());
  return { w: size.x, d: size.z, h: size.y };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
