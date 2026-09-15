// Render views for the `render` tool (spec 04 section 3, ADR-005 D6). Camera placement is pure and
// tested in Node; the capture step (WebGL to PNG) is injected by the app shell.
import type { RenderRequestMsg } from "@fpv/commands";
import type { Project } from "@fpv/ir";
import { derive, poly } from "@fpv/ir";
import * as THREE from "three";
import type { SceneBinding } from "./binding.js";

export interface ViewCamera {
  name: string;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
}

export interface CapturedImage {
  view: string;
  pngBase64: string;
  width: number;
  height: number;
}

export type Capture = (camera: THREE.Camera, name: string, width: number, height: number) => Promise<string>;

const OVERHEAD_ANGLES: { name: string; dx: number; dz: number }[] = [
  { name: "overhead-ne", dx: 1, dz: -1 },
  { name: "overhead-nw", dx: -1, dz: -1 },
  { name: "overhead-se", dx: 1, dz: 1 },
  { name: "overhead-sw", dx: -1, dz: 1 },
];

/** Bounds of the focused entity in the three.js frame, or null when the id does not resolve. */
export function focusBounds(project: Project, focusId: string | null): THREE.Box3 | null {
  if (!focusId) return null;
  const room = project.rooms.find((r) => r.id === focusId);
  if (room) {
    const level = derive.levelOf(project, room.levelId);
    const b = derive.roomBounds(room);
    const floor = (level?.elevation ?? 0) / 1000;
    const height = (room.ceilingHeight ?? level?.height ?? 2700) / 1000;
    return new THREE.Box3(
      new THREE.Vector3(b.minX / 1000, floor, -b.maxY / 1000),
      new THREE.Vector3(b.maxX / 1000, floor + height, -b.minY / 1000),
    );
  }
  const item = project.items.find((i) => i.id === focusId);
  if (item) {
    const size = derive.itemSize(item, derive.snapshotSizeSource(project));
    if (!size) return null;
    const fp = poly.bounds(derive.itemFootprint(item, size));
    const level = derive.levelOf(project, item.levelId);
    const ground = level ? derive.itemGroundElevation(item, level) / 1000 : 0;
    return new THREE.Box3(
      new THREE.Vector3(fp.minX / 1000, ground, -fp.maxY / 1000),
      new THREE.Vector3(fp.maxX / 1000, ground + size.h / 1000, -fp.minY / 1000),
    );
  }
  return null;
}

/** Cameras for a request: four corners for overhead, an orthographic top-down for plan, one view otherwise. */
export function camerasFor(
  view: RenderRequestMsg["views"][number]["name"] | string,
  target: THREE.Box3,
  aspect: number,
): ViewCamera[] {
  const centre = target.getCenter(new THREE.Vector3());
  const size = target.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.z, 1) * 0.5;
  // distance that fits the target's bounding sphere in the vertical field of view
  const fit = (fovDeg: number, margin = 1.05) =>
    (Math.max(size.length() / 2, 0.5) * margin) / Math.sin((fovDeg * Math.PI) / 360);
  const out: ViewCamera[] = [];
  const perspective = (name: string, position: THREE.Vector3, lookAt: THREE.Vector3, fov = 45) => {
    const cam = new THREE.PerspectiveCamera(fov, aspect, 0.05, 500);
    cam.position.copy(position);
    cam.lookAt(lookAt);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    out.push({ name, camera: cam });
  };
  if (view === "plan") {
    const halfW = Math.max(radius, (Math.max(size.z, 1) * 0.5 * aspect) / 1) * 1.1;
    const halfH = halfW / aspect;
    const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.05, 500);
    cam.position.set(centre.x, target.max.y + 50, centre.z);
    cam.up.set(0, 0, -1); // +y in the plan points up the image
    cam.lookAt(centre.x, centre.y, centre.z);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    out.push({ name: "plan", camera: cam });
    return out;
  }
  if (view.startsWith("overhead")) {
    const angles = view === "overhead" ? OVERHEAD_ANGLES : OVERHEAD_ANGLES.filter((a) => a.name === view);
    const dist = fit(45);
    for (const a of angles) {
      const dir = new THREE.Vector3(a.dx, 1.1, a.dz).normalize();
      perspective(a.name, centre.clone().addScaledVector(dir, dist), centre);
    }
    return out;
  }
  if (view === "eye") {
    // standing inside: 1.6 m eye height, near the south side, looking north across the space
    const eye = new THREE.Vector3(centre.x, target.min.y + 1.6, target.max.z - Math.min(1, size.z * 0.2));
    perspective("eye", eye, new THREE.Vector3(centre.x, target.min.y + 1.2, target.min.z), 60);
    return out;
  }
  // room (and any unknown name): a three-quarter view from above the south-east corner
  const dist = fit(45);
  const dir = new THREE.Vector3(0.8, 0.75, 0.8).normalize();
  perspective(view, centre.clone().addScaledVector(dir, dist), centre);
  return out;
}

/**
 * Answer a render request: pick the target bounds, hide walls and ceilings when asked, capture every
 * view, and restore visibility whatever happens.
 */
export async function renderViews(
  binding: SceneBinding,
  project: Project | null,
  req: RenderRequestMsg,
  capture: Capture,
): Promise<CapturedImage[]> {
  binding.flush(); // changes that arrived since the last frame must be in the scene before capture
  const width = req.width || 1024;
  const height = Math.round((width * 3) / 4);
  const target =
    (project && focusBounds(project, req.focusId)) ??
    (binding.bounds.isEmpty()
      ? new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5))
      : binding.bounds.clone());
  const wanted = req.views.length > 0 ? req.views.map((v) => v.name) : ["room"];
  const view =
    wanted.length === 4 && wanted.every((n) => n.startsWith("overhead")) ? "overhead" : (wanted[0] as string);
  const cameras = camerasFor(view, target, width / height);
  const hidden: THREE.Object3D[] = [];
  if (req.hideWalls) {
    for (const o of binding.walls.children) if (o.visible) hidden.push(o);
    for (const o of binding.rooms.children)
      if (o.visible && (o.userData as { part?: string }).part === "ceiling") hidden.push(o);
    for (const o of hidden) o.visible = false;
  }
  try {
    const images: CapturedImage[] = [];
    for (const { name, camera } of cameras) {
      const pngBase64 = await capture(camera, name, width, height);
      images.push({ view: name, pngBase64, width, height });
    }
    return images;
  } finally {
    for (const o of hidden) o.visible = true;
  }
}
