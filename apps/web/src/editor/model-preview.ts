// The model import dialog's 3D preview (PRD P3-8): the model as it will stand, stood up and turned as
// asked, centred on a floor grid with a blue arrow along +z, the way every product faces. Seen from in
// front, so a model that faces the person looking at it faces the right way. Imperative three.js, like the
// viewport (ADR-018); the dialog owns the canvas and disposes the preview when it closes.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface ModelPreview {
  show(model: THREE.Object3D, turn: number, tip: number): void;
  dispose(): void;
}

const FRONT = 0x1e88e5;

export function createModelPreview(canvas: HTMLCanvasElement): ModelPreview {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(canvas.clientWidth || 400, canvas.clientHeight || 220, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf3f1ec);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 6, 4);
  scene.add(sun, new THREE.HemisphereLight(0xffffff, 0xa8a8a8, 1.2));
  // the model turns inside `holder`, which `place` moves so it stands centred on the grid
  const place = new THREE.Group();
  const holder = new THREE.Group();
  place.add(holder);
  const guides = new THREE.Group();
  scene.add(place, guides);
  const camera = new THREE.PerspectiveCamera(
    35,
    (canvas.clientWidth || 400) / (canvas.clientHeight || 220),
    0.01,
    1000,
  );
  const controls = new OrbitControls(camera, canvas);
  const render = () => renderer.render(scene, camera);
  controls.addEventListener("change", render);

  const clearGuides = () => {
    for (const g of [...guides.children]) {
      g.removeFromParent();
      g.traverse((o) => {
        (o as THREE.Mesh).geometry?.dispose();
        const m = (o as THREE.Mesh).material;
        for (const x of Array.isArray(m) ? m : m ? [m] : []) x.dispose();
      });
    }
  };

  return {
    show(model, turn, tip) {
      if (model.parent !== holder) {
        holder.clear();
        holder.add(model);
      }
      // stand up about x first, then turn about the vertical: the order the host applies them in
      holder.rotation.set((-tip * Math.PI) / 2, (turn * Math.PI) / 2, 0, "YXZ");
      place.position.set(0, 0, 0);
      place.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(holder, true);
      if (box.isEmpty()) return render();
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      place.position.set(-centre.x, -box.min.y, -centre.z);
      const span = Math.max(size.x, size.y, size.z) || 1;
      clearGuides();
      const floor = Math.max(size.x, size.z) * 1.6 || 1;
      const grid = new THREE.GridHelper(floor, 8, 0xb8b4ab, 0xd9d5cc);
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(0, span * 0.002, size.z / 2 + span * 0.05),
        Math.max(size.x, size.z) * 0.45 || 0.5,
        FRONT,
      );
      guides.add(grid, arrow);
      const distance = span * 2.4;
      camera.near = span / 200;
      camera.far = span * 50;
      camera.position.set(distance * 0.5, size.y * 0.5 + distance * 0.35, distance);
      camera.updateProjectionMatrix();
      controls.target.set(0, size.y / 2, 0);
      controls.update();
      render();
    },
    dispose() {
      controls.removeEventListener("change", render);
      controls.dispose();
      clearGuides();
      holder.clear();
      renderer.dispose();
      // the context goes with the dialog, and every buffer the model put on the card with it
      renderer.forceContextLoss();
    },
  };
}
