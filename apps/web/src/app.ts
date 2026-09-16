// Browser shell: renderer, controls, plan canvases, bridge connection. Everything DOM-bound lives here;
// the binding, the plan renderer and the bridge client are testable without it.
import type { Layer } from "@fpv/engine";
import { SELECTION_PX } from "@fpv/geometry";
import { derive } from "@fpv/ir";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { BridgeClient, bridgeUrl } from "./bridge/client.js";
import { moveCommands, nextSelection } from "./editor/selection.js";
import { type Ctx2D, outlineOf, PlanRenderer, type PlanView } from "./plan/plan.js";
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
  /** Ask for the plan to be drawn again on the next frame. */
  redraw: () => void;
  /** Paint the drag ghost; the shell composes this into its single overlay painter. */
  drawSelectionDrag: (ctx: Ctx2D, view: PlanView) => void;
  /** Release what startApp attached to the document: the size observer and the window listener. */
  destroy: () => void;
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

  // Sizing is two jobs, and conflating them is why the splitter could not work. `resizeBuffers` matches
  // the drawing surfaces to their boxes; `resize` does that AND re-frames the drawing. Dragging a divider
  // must only ever do the first — re-fitting on every pointer move would wrench the pan and zoom out from
  // under whoever is dragging.
  //
  // The sizes are read off el.plan and el.viewport, never off a canvas: the canvases are absolutely
  // positioned inside el.plan, so mid-resize they still report the size they are about to stop being.
  const resizeBuffers = () => {
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
    planDirty = true;
  };

  /** Buffers AND re-frame. This is also the restore path after a render capture, which deliberately
   *  leaves the renderer and the plan at the captured size (see capturePlan and onRender's finally). */
  const resize = () => {
    resizeBuffers();
    plan.fit();
    planDirty = true;
  };

  // A ResizeObserver, not a window listener: dragging the 2D/3D divider changes these boxes without the
  // window changing at all, and before this the canvas kept its old backing store — a blurry plan and a
  // 3D camera on a stale aspect. The observer covers window resizes too, so there is no second listener.
  const sizes = new ResizeObserver(() => {
    // A zero box means the pane is hidden (a single-pane view mode) rather than resized. Sizing a buffer
    // to zero there would discard the drawing and force a full repaint when it comes back.
    if (el.plan.clientHeight > 0 || el.viewport.clientHeight > 0) resizeBuffers();
  });
  const observeSizes = () => {
    sizes.observe(el.plan);
    sizes.observe(el.viewport);
  };

  // pan, zoom, and dragging a selection on the plan
  let drag: { x: number; y: number } | null = null;
  /**
   * A press that began on something already selected: that drags the selection instead of panning.
   *
   * `dx`/`dy` are the live offset in plan millimetres, updated on every move so the ghost can follow the
   * pointer. Without them the drag was invisible until the button came up, which made a working move
   * feel like nothing was happening.
   */
  let moving: { fromX: number; fromY: number; ids: string[]; dx: number; dy: number } | null = null;

  /** Screen pixels between two pointer positions, in plan millimetres. y flips: plan y is up. */
  const deltaMm = (fromX: number, fromY: number, toX: number, toY: number) => {
    const dpr = Math.min(2, window.devicePixelRatio);
    return {
      dx: ((toX - fromX) * dpr) / plan.view.scale,
      dy: -((toY - fromY) * dpr) / plan.view.scale,
    };
  };

  const planPointOf = (e: { clientX: number; clientY: number }) => {
    const rect = el.plan.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio);
    return plan.toPlan((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr);
  };

  el.plan.addEventListener("pointerdown", (e) => {
    // Pressing on an entity that is ALREADY selected moves the selection; pressing anywhere else still
    // pans. Requiring it to be selected first is what keeps panning usable: otherwise every press that
    // happened to land on a wall would drag it.
    const hit = plan.hitTest(planPointOf(e), SELECTION_PX / plan.view.scale);
    if (hit && replica.selection.includes(hit))
      moving = { fromX: e.clientX, fromY: e.clientY, ids: [...replica.selection], dx: 0, dy: 0 };
    drag = { x: e.clientX, y: e.clientY };
    el.plan.setPointerCapture(e.pointerId);
  });
  el.plan.addEventListener("pointermove", (e) => {
    if (moving) {
      // The view holds still while a selection is dragged, but the ghost has to follow the pointer:
      // repaint the overlay on every move, or the drag stays invisible until the button comes up.
      const { dx, dy } = deltaMm(moving.fromX, moving.fromY, e.clientX, e.clientY);
      moving = { ...moving, dx, dy };
      plan.invalidateOverlay();
      planDirty = true;
      return;
    }
    if (!drag) return;
    const dpr = Math.min(2, window.devicePixelRatio);
    plan.panBy((e.clientX - drag.x) * dpr, (e.clientY - drag.y) * dpr);
    drag = { x: e.clientX, y: e.clientY };
    planDirty = true;
  });
  el.plan.addEventListener("pointerup", (e) => {
    if (moving) {
      const moved = moving;
      moving = null;
      drag = null;
      const dxPx = e.clientX - moved.fromX;
      const dyPx = e.clientY - moved.fromY;
      // Under the 3 px threshold this was a click, not a drag: fall through to selection next time
      // rather than committing a move of nothing.
      if (Math.hypot(dxPx, dyPx) >= 3 && replica.project) {
        const { dx, dy } = deltaMm(moved.fromX, moved.fromY, e.clientX, e.clientY);
        for (const command of moveCommands(replica.project, moved.ids, dx, dy)) void client.command(command);
      }
      // The ghost goes as the real geometry arrives; leaving it up would briefly show both.
      plan.invalidateOverlay();
      planDirty = true;
      return;
    }
    if (drag && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 3) {
      const rect = el.plan.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio);
      const at = plan.toPlan((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr);
      if (review.active) review.select(review.hitWall(at, plan.view.scale));
      else {
        // Shift toggles, a plain click replaces, and a click on bare plan clears (F-138, F-140, F-141).
        // The rules live in selection.ts so the shell and this handler cannot drift apart on them.
        // F-130: the selection margin is 4 px, expressed in millimetres at the current scale. Without it
        // a thin wall's footprint is about a pixel wide on screen and cannot be clicked at all.
        const marginMm = SELECTION_PX / plan.view.scale;
        const id = plan.hitTest(at, marginMm);
        void client.select(nextSelection(replica.selection, id, e.shiftKey));
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
  // Whether the camera has ever framed actual geometry. A new project's first snapshot is empty, so
  // fitCamera() returns at its own isEmpty() guard and — because it only ran behind `firstSnapshot` —
  // was never called again. The camera stayed at its constructor position while walls were built well
  // outside the frustum, so drawing on the plan appeared to do nothing at all in 3D.
  let framedSomething = false;
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
      framedSomething = !binding.bounds.isEmpty();
    } else {
      binding.onChanges(changes, project);
      plan.onChanges(changes, project);
      // The first geometry to arrive in an empty project gets framed once. Only once: re-framing on every
      // change would fight the orbit controls every time a wall is drawn.
      if (!framedSomething) {
        requestAnimationFrame(() => {
          binding.flush();
          if (binding.bounds.isEmpty()) return;
          framedSomething = true;
          fitCamera();
        });
      }
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
  // Only the input is needed: React renders the visible button and clicks the input itself, so the
  // import path must not depend on a button element being handed in (ADR-018 D1).
  if (el.importFile) {
    const input = el.importFile;
    el.importButton?.addEventListener("click", () => input.click());
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
  observeSizes(); // after resize(): see the note on `sizes` for why this order matters
  updateStatus();
  requestAnimationFrame(loop);
  return {
    replica,
    binding,
    plan,
    review,
    client,
    // React drives the zoom dock, and `planDirty` is a closure variable in here. Without this the dock's
    // buttons changed plan.view and nothing ever flushed, so zooming by button did nothing at all while
    // the wheel — which sets planDirty itself — worked fine.
    redraw: () => {
      planDirty = true;
    },
    /**
     * The selection being dragged, drawn where it would land. Joins the shell's overlay composition
     * rather than registering its own painter, because setOverlayExtra takes a single function.
     *
     * A ghost rather than the real geometry: moving the structure layer live would mean recomputing
     * every wall join on each pointer move, which fights the mitring for no gain — the committed move
     * lands a frame later anyway.
     */
    drawSelectionDrag: (ctx: Ctx2D, view: PlanView) => {
      const project = replica.project;
      const level = plan.level;
      if (!moving || !project || !level) return;
      // Read once: `moving` is a mutable closure variable, so the narrowing above does not survive into
      // the callback below.
      const { ids, dx, dy } = moving;
      if (dx === 0 && dy === 0) return;
      const sizes = derive.snapshotSizeSource(project);
      ctx.strokeStyle = "#1e88e5";
      ctx.lineWidth = 2 / view.scale;
      ctx.setLineDash([6 / view.scale, 4 / view.scale]);
      for (const id of ids) {
        const outline = outlineOf(project, id, level, sizes);
        if (!outline || outline.length === 0) continue;
        ctx.beginPath();
        outline.forEach((p, i) => {
          const x = p.x + dx;
          const y = p.y + dy;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.stroke();
      }
      ctx.setLineDash([]);
    },
    destroy: () => sizes.disconnect(),
  };
}

/** A file's bytes as base64, in chunks so large images do not overflow the argument list. */
async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
