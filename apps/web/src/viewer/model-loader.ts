// The browser's model loader (ADR-003 D5): glTF from the host's /models/<key>, with the meshopt decoder
// the offline pipeline compresses with (ADR-010 D3). Kept apart from models.ts so Node tests never load it.

import type { LoadingManager } from "three";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ModelLoad } from "./models.js";

/** A glTF loader with the decoders the app supports; a manager can point a .gltf's files elsewhere. */
export function gltfLoader(manager?: LoadingManager): GLTFLoader {
  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

export function hostModelLoad(base = "/models/"): ModelLoad {
  const loader = gltfLoader();
  return async (key, version) => {
    const path = key.split("/").map(encodeURIComponent).join("/");
    const gltf = await loader.loadAsync(`${base}${path}${version ? `?v=${version.slice(0, 12)}` : ""}`);
    return gltf.scene;
  };
}
