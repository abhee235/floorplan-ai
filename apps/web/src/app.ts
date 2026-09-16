// Browser shell: renderer, controls, plan canvases, bridge connection. Everything DOM-bound lives here;
// the binding, the plan renderer and the bridge client are testable without it.
import type { Layer } from "@fpv/engine";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { BridgeClient, bridgeUrl } from "./bridge/client.js";
import { type Ctx2D, PlanRenderer } from "./plan/plan.js";
import { DraftReview } from "./plan/review.js";
import { Replica } from "./replica.js";
import { mountReviewPanel } from "./review-panel.js";
import { frameScheduler, SceneBinding } from "./viewer/binding.js";
import { clippingFor } from "./viewer/clipping.js";
import { renderViews } from "./viewer/render.js";

export const CLIENT_VERSION = "0.0.1";

export interface AppElements {
  viewport: HTMLElement;
  plan: HTMLElement;
  status: HTMLElement;
  fit: HTMLButtonElement;
  /** "Import plan" button and its hidden file input; optional so older shells still start. */
  importButton?: HTMLButtonElement;
  importFile?: HTMLInputElement;
  /** Panel for reviewing a plan draft, placed over the plan. */
  review?: HTMLElement;
}

export function startApp(el: AppElements): {
  replica: Replica;
  binding: SceneBinding;
  plan: PlanRenderer;
  review: DraftReview;
  client: BridgeClient;
} {
  const replica = new Replica();
  const raf = (cb: () => void) => requestAnimationFrame(cb);
  const binding = new SceneBinding({ scheduler: frameScheduler(raf) });

  // ---- 3D ----
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  el.viewport.appendChild(renderer.domElement);
  binding.scene.background = new THREE.Color(0xf3f1ec);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
  camera.position.set(12, 9, 12);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  const frame3d = () => {
    binding.updateCamera(camera);
    const centre = binding.bounds.isEmpty()
      ? new THREE.Vector3()
      : binding.bounds.getCenter(new THREE.Vector3());
    const diag = binding.bounds.isEmpty() ? 0 : binding.bounds.getSize(new THREE.Vector3()).length();
    const clip = clippingFor(camera.position.distanceTo(centre), diag);
    if (Math.abs(camera.near - clip.near) > 1e-6 || Math.abs(camera.far - clip.far) > 1e-3) {
      camera.near = clip.near;
      camera.far = clip.far;
      camera.updateProjectionMatrix();
    }
  };

  const fitCamera = () => {
    if (binding.bounds.isEmpty()) return;
    const centre = binding.bounds.getCenter(new THREE.Vector3());
    const size = binding.bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z) * 0.75 + 2;
    camera.position.set(centre.x + radius, radius * 0.9, centre.z + radius);
    controls.target.copy(centre);
    controls.update();
  };

  // ---- plan ----
  const layerNames: Layer[] = ["static", "structure", "items", "overlay"];
  const canvases = new Map<Layer, HTMLCanvasElement>();
  const contexts = {} as Record<Layer, Ctx2D>;
  for (const name of layerNames) {
    const c = document.createElement("canvas");
    c.className = `plan-layer plan-${name}`;
    el.plan.appendChild(c);
    canvases.set(name, c);
    contexts[name] = c.getContext("2d") as unknown as Ctx2D;
  }
  const plan = new PlanRenderer(contexts, el.plan.clientWidth || 400, el.plan.clientHeight || 300);
  let planDirty = true;

  // ---- plan draft review (ADR-011 D5) ----
  const review = new DraftReview();
  plan.setOverlayExtra((ctx, view) => review.draw(ctx, view));
  const fitDraft = () => {
    const b = review.boundsMm();
    if (b) plan.fitBounds(b);
    planDirty = true;
  };
  review.subscribe(() => {
    plan.invalidateOverlay();
    planDirty = true;
  });

  const resize = () => {
    const w = el.viewport.clientWidth || 400;
    const h = el.viewport.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const pw = el.plan.clientWidth || 400;
    const ph = el.plan.clientHeight || 300;
    const dpr = Math.min(2, window.devicePixelRatio);
    for (const c of canvases.values()) {
      c.width = Math.round(pw * dpr);
      c.height = Math.round(ph * dpr);
      c.style.width = `${pw}px`;
      c.style.height = `${ph}px`;
    }
    plan.resize(pw * dpr, ph * dpr);
    plan.fit();
    planDirty = true;
  };
  window.addEventListener("resize", resize);

  // pan and zoom on the plan
  let drag: { x: number; y: number } | null = null;
  el.plan.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY };
    el.plan.setPointerCapture(e.pointerId);
  });
  el.plan.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dpr = Math.min(2, window.devicePixelRatio);
    plan.panBy((e.clientX - drag.x) * dpr, (e.clientY - drag.y) * dpr);
    drag = { x: e.clientX, y: e.clientY };
    planDirty = true;
  });
  el.plan.addEventListener("pointerup", (e) => {
    if (drag && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 3) {
      const rect = el.plan.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio);
      const at = plan.toPlan((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr);
      if (review.active) review.select(review.hitWall(at, plan.view.scale));
      else {
        const id = plan.hitTest(at);
        void client.select(id ? [id] : []);
      }
    }
    drag = null;
  });
  el.plan.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = el.plan.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio);
      plan.zoomAt(
        (e.clientX - rect.left) * dpr,
        (e.clientY - rect.top) * dpr,
        e.deltaY < 0 ? 1.15 : 1 / 1.15,
      );
      planDirty = true;
    },
    { passive: false },
  );
  el.fit.addEventListener("click", () => {
    plan.fit();
    planDirty = true;
    fitCamera();
  });

  /** The plan drawing at a given size: redraw every layer into an offscreen canvas and encode it. */
  const capturePlan = (w: number, h: number): string => {
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const ctx = off.getContext("2d") as CanvasRenderingContext2D;
    ctx.fillStyle = "#fbfaf7";
    ctx.fillRect(0, 0, w, h);
    const saved = plan.view;
    plan.resize(w, h);
    plan.fit(24);
    const scratch = {} as Record<Layer, Ctx2D>;
    const scratchCanvases: HTMLCanvasElement[] = [];
    for (const name of layerNames) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      scratchCanvases.push(c);
      scratch[name] = c.getContext("2d") as unknown as Ctx2D;
    }
    const snapshot = new PlanRenderer(scratch, w, h);
    if (replica.project) snapshot.setProject(replica.project);
    snapshot.view = plan.view;
    snapshot.setSelection(replica.selection);
    snapshot.flush();
    for (const c of scratchCanvases) ctx.drawImage(c, 0, 0);
    plan.view = saved;
    planDirty = true;
    return off.toDataURL("image/png").split(",")[1] ?? "";
  };

  // ---- replica -> binding + plan ----
  let firstSnapshot = true;
  replica.subscribe(({ changes, project }) => {
    if (changes.commandType === "snapshot") {
      binding.setProject(project);
      plan.setProject(project);
      plan.fit();
      if (firstSnapshot) {
        firstSnapshot = false;
        requestAnimationFrame(() => {
          binding.flush();
          fitCamera();
        });
      }
    } else {
      binding.onChanges(changes, project);
      plan.onChanges(changes, project);
    }
    planDirty = true;
    updateStatus();
  });

  const updateStatus = () => {
    const p = replica.project;
    const errors = replica.problems.filter((x) => x.severity === "error").length;
    const warnings = replica.problems.length - errors;
    el.status.textContent = p
      ? `${p.meta.name} · ${p.walls.length} walls · ${p.rooms.length} rooms · ${p.items.length} items · history ${replica.historyPosition} · ${errors} errors, ${warnings} warnings · bridge ${client.status}`
      : `bridge ${client.status}`;
  };

  // ---- bridge ----
  const socket = new WebSocket(bridgeUrl(window.location));
  const client = new BridgeClient(socket, replica, {
    clientVersion: CLIENT_VERSION,
    capabilities: ["render", "plan"],
    onStatus: () => updateStatus(),
    onDraft: (msg) => {
      const wasActive = review.active;
      review.open(msg);
      if (msg.image) {
        const img = new Image();
        img.onload = () => review.setImage(img);
        img.src = msg.image.dataUrl;
      }
      if (review.active && !wasActive) fitDraft();
      if (!review.active) {
        plan.fit();
        planDirty = true;
      }
    },
    onRender: async (req) => {
      // capture each view at the requested size on the live renderer, then restore the viewport
      const capture = async (camera: THREE.Camera, name: string, w: number, h: number) => {
        if (name === "plan") return capturePlan(w, h);
        renderer.setSize(w, h, false);
        if (camera instanceof THREE.PerspectiveCamera) {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        }
        binding.updateCamera(camera);
        renderer.render(binding.scene, camera);
        return renderer.domElement.toDataURL("image/png").split(",")[1] ?? "";
      };
      try {
        return await renderViews(binding, replica.project, req, capture);
      } finally {
        resize();
      }
    },
  });
  const selectionPoll = () => {
    binding.setSelection(replica.selection);
    plan.setSelection(replica.selection);
    planDirty = true;
  };
  let lastSelection = "";

  // ---- frame loop ----
  const loop = () => {
    const sel = replica.selection.join(",");
    if (sel !== lastSelection) {
      lastSelection = sel;
      selectionPoll();
    }
    if (planDirty) {
      plan.flush();
      planDirty = false;
    }
    controls.update();
    frame3d();
    renderer.render(binding.scene, camera);
    requestAnimationFrame(loop);
  };
  if (el.review)
    mountReviewPanel(el.review, review, {
      fit: fitDraft,
      cancel: () => review.close(),
      commit: async () => {
        try {
          const r = await client.tool("import_plan", review.commitArgs());
          if (!r.ok)
            return r.error
              ? `${r.error.message}${r.error.hint ? ` (${r.error.hint})` : ""}`
              : "the import failed";
          review.close();
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
    });
  if (el.importButton && el.importFile) {
    const input = el.importFile;
    el.importButton.addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      el.status.textContent = `reading ${file.name}…`;
      try {
        const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|pdf)$/i.test(file.name);
        const r = await client.tool(
          "import_plan",
          isImage
            ? { contentBase64: await fileToBase64(file), fileName: file.name }
            : { content: await file.text(), fileName: file.name },
        );
        // the host shows the draft through a draft message; only failures need handling here
        if (!r.ok) el.status.textContent = `import failed: ${r.error?.message ?? "unknown error"}`;
        else updateStatus();
      } catch (e) {
        el.status.textContent = `import failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    });
  }
  resize();
  updateStatus();
  requestAnimationFrame(loop);
  return { replica, binding, plan, review, client };
}

/** A file's bytes as base64, in chunks so large images do not overflow the argument list. */
async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
