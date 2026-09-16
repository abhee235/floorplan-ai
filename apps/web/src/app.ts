// Browser shell: renderer, controls, plan canvases, bridge connection. Everything DOM-bound lives here;
// the binding, the plan renderer and the bridge client are testable without it.
import { apply, type ChangeSet } from "@fpv/commands";
import type { Layer } from "@fpv/engine";
import { SELECTION_PX, WALL_END_PX, wallFootprintUnjoined } from "@fpv/geometry";
import type { Item, Project, Size3, Wall } from "@fpv/ir";
import { derive, sequentialIdGenerator } from "@fpv/ir";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { BridgeClient, bridgeUrl } from "./bridge/client.js";
import {
  footprintOf,
  type ItemCommand,
  type ItemHandle,
  itemHandleAnchors,
  itemHandleAt,
  itemHandleCursor,
  resizeCommands,
  rotateCommand,
} from "./editor/item-handles.js";
import { moveCommands, nextSelection } from "./editor/selection.js";
import {
  handleAnchors,
  handleAt,
  handleCommand,
  handleCursor,
  indicatorMarginMm,
  previewWall,
  type WallHandle,
} from "./editor/wall-handles.js";
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
  /**
   * Told the plan's scale, in device pixels per millimetre, whenever it changes: on zoom, fit and resize
   * as well as on a project change. The zoom readout used to hear only the last, so it sat on the scale
   * it opened with while the plan zoomed under it.
   */
  onScale?: (pixelsPerMm: number) => void;
}

/**
 * The selection blue, shared by the drag ghost, the reshape preview and the wall handles.
 *
 * The plan renderer keeps the same value in its own private COLOURS table. One name here beats the bare
 * literal repeated at each use, and the two are meant to match: a handle belongs to the outline it sits on.
 */
const HANDLE_COLOUR = "#1e88e5";

export function startApp(el: AppElements): {
  replica: Replica;
  binding: SceneBinding;
  plan: PlanRenderer;
  review: DraftReview;
  client: BridgeClient;
  /** Ask for the plan to be drawn again on the next frame. */
  redraw: () => void;
  /** Show a command's effect without sending it; null puts the host's project back. */
  preview: (command: { type: string; payload: unknown } | null) => void;
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
  // Glass needs something to reflect or it is only a tinted pane. A soft studio room, prefiltered once,
  // given to glass and its frames alone: the scene is not lit by it, so everything else looks as before.
  {
    const pmrem = new THREE.PMREMGenerator(renderer);
    binding.setEnvironment(pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
    pmrem.dispose();
  }
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
  let moving: {
    fromX: number;
    fromY: number;
    ids: string[];
    dx: number;
    dy: number;
    /** The project as the host last agreed it was, so every move measures from one fixed starting point
     *  and the gesture can be put back if the host refuses it. */
    before: Project;
  } | null = null;

  /**
   * Run commands against a project without involving the host.
   *
   * The real reducer, not a copy of what it does: a wall move drags its joined neighbours along (W-031),
   * a room move rewrites every point, and re-implementing any of that here would drift from the version
   * that finally runs. Whatever comes back is exactly what the host will produce from the same commands.
   *
   * The id generator is never reached — moving nothing creates nothing — but `apply` requires one.
   */
  const localCtx = { ids: sequentialIdGenerator(1), now: () => new Date().toISOString() };
  const applyLocally = (from: Project, commands: readonly { type: string; payload: unknown }[]) => {
    let project = from;
    const updated: ChangeSet["updated"] = [];
    for (const command of commands) {
      const result = apply(project, command, localCtx);
      if (!result.ok) return null; // a move the host would refuse: show nothing rather than a lie
      project = result.project;
      for (const ref of result.changes.updated)
        if (!updated.some((u) => u.type === ref.type && u.id === ref.id)) updated.push(ref);
    }
    return { project, changes: { commandType: "local.move", added: [], updated, removed: [] } };
  };

  /**
   * What a command would do, shown without the host: a number typed or dragged in the properties panel.
   * Every call applies its command to the project the host last agreed, so a drag never compounds; null
   * puts that project back, which is also what happens just before the real command is sent, so the
   * host's patch lands on the state it was made against. A patch from the host while a preview is up (the
   * agent, another window) takes the view away, and the preview is shown again on top of it (below).
   */
  let previewing: { type: string; payload: unknown } | null = null;
  const preview = (command: { type: string; payload: unknown } | null): void => {
    previewing = command;
    const base = replica.agreed;
    const local = command && base ? applyLocally(base, [command]) : null;
    // a value the host would refuse shows nothing rather than a lie
    if (local) replica.applyLocally(local.project, { ...local.changes, commandType: "local.preview" });
    else replica.restore();
    planDirty = true;
  };

  /** Screen pixels between two pointer positions, in plan millimetres. y flips: plan y is up. */
  const deltaMm = (fromX: number, fromY: number, toX: number, toY: number) => {
    const dpr = Math.min(2, window.devicePixelRatio);
    return {
      dx: ((toX - fromX) * dpr) / plan.view.scale,
      dy: -((toY - fromY) * dpr) / plan.view.scale,
    };
  };

  /**
   * A press that began on a handle of the selected wall: that reshapes the wall rather than moving it or
   * panning the view.
   *
   * `preview` is the wall as it would be, recomputed on every move so that the drag shows its result
   * while the button is still down. Endpoint and arc drags change the wall's SHAPE, so the translated
   * outline a selection move draws cannot stand in for them.
   */
  let handling: {
    wallId: string;
    handle: WallHandle;
    /** The wall as the host last agreed it was: what every move measures its new shape from. */
    before: Wall;
    /** The whole project as it was, because the reducer needs something to apply against — and because
     *  a reshape reaches further than its own wall, so putting it back means putting all of it back. */
    beforeProject: Project;
    preview: Wall | null;
  } | null = null;

  /**
   * A press that began on a handle of the selected item: a resize or a turn. Like a wall handle drag, it
   * runs the real reducer on the project as it was at the press, on every move, and sends one
   * transaction when the button comes up.
   */
  let itemHandling: {
    item: Item;
    size: Size3;
    handle: ItemHandle;
    from: { x: number; y: number };
    beforeProject: Project;
    commands: ItemCommand[];
  } | null = null;

  /** The item the handles belong to: exactly one item selected, on the level being drawn, with a size. */
  const handleItem = (): { item: Item; size: Size3; resizable: boolean } | null => {
    const project = replica.project;
    if (!project || replica.selection.length !== 1) return null;
    const id = replica.selection[0] as string;
    const item = project.items.find((x) => x.id === id && x.levelId === plan.level);
    if (!item) return null;
    const size = derive.itemSize(item, derive.snapshotSizeSource(project));
    if (!size) return null;
    // a product the catalog says comes in one size can only be turned (F-013)
    const snap =
      item.ref.kind === "product"
        ? (project.catalogRefs[item.ref.productId] as { deformable?: boolean } | undefined)
        : undefined;
    return { item, size, resizable: snap?.deformable !== false };
  };

  /** The item and whatever is stacked on it: everything its resize or turn can move. */
  const touchedByItem = (project: Project, itemId: string): ChangeSet["updated"] => {
    const ids = new Set([itemId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const it of project.items)
        if (it.parentId && ids.has(it.parentId) && !ids.has(it.id)) {
          ids.add(it.id);
          grew = true;
        }
    }
    return [...ids].map((id) => ({ type: "item" as const, id }));
  };

  /** The handles on the selected item: squares on its corners and edges, and a turn handle off its front. */
  const drawItemHandles = (
    ctx: Ctx2D,
    view: PlanView,
    target: { item: Item; size: Size3; resizable: boolean },
  ) => {
    const anchors = itemHandleAnchors(target.item, target.size, 1 / view.scale, target.resizable);
    const screen = (p: { x: number; y: number }) => ({
      x: view.offsetX + p.x * view.scale,
      y: view.offsetY - p.y * view.scale,
    });
    const fp = footprintOf(target.item, target.size);
    const frontMid = screen({
      x: ((fp[2]?.x ?? 0) + (fp[3]?.x ?? 0)) / 2,
      y: ((fp[2]?.y ?? 0) + (fp[3]?.y ?? 0)) / 2,
    });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = HANDLE_COLOUR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    for (const a of anchors) {
      const p = screen(a.at);
      if (a.handle.kind === "rotate") {
        // a stalk from the front edge to a ring: turn the item by its front
        ctx.beginPath();
        ctx.moveTo(frontMid.x, frontMid.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.stroke();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(p.x - 4, p.y - 4);
      ctx.lineTo(p.x + 4, p.y - 4);
      ctx.lineTo(p.x + 4, p.y + 4);
      ctx.lineTo(p.x - 4, p.y + 4);
      ctx.closePath();
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  };

  /** The wall the handles belong to: exactly one wall selected, on the level being drawn, or null. */
  const handleWall = (): Wall | null => {
    if (replica.selection.length !== 1) return null;
    const id = replica.selection[0] as string;
    const level = plan.level;
    return replica.project?.walls.find((x) => x.id === id && x.levelId === level) ?? null;
  };

  const planPointOf = (e: { clientX: number; clientY: number }) => {
    const rect = el.plan.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio);
    return plan.toPlan((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr);
  };

  /**
   * The handles on a selected wall: one at each end to pull it out, one on a side surface to bend it.
   *
   * Authored in screen pixels and rotated by hand rather than drawn under the layer's transform. That
   * transform scales with the zoom and flips y, so a glyph drawn through it would shrink to nothing as
   * the plan zoomed out and every arrowhead would come out mirrored.
   */
  const drawWallHandles = (ctx: Ctx2D, view: PlanView, w: Wall) => {
    const anchors = handleAnchors(w, wallFootprintUnjoined(w));
    if (!anchors) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = HANDLE_COLOUR;
    // Thick enough to read at a glance: at 1.5 the glyphs were a few specks beside the wall.
    ctx.lineWidth = 2;
    for (const kind of ["start", "end", "arc"] as const) {
      const anchor = anchors[kind];
      const sx = view.offsetX + anchor.at.x * view.scale;
      const sy = view.offsetY - anchor.at.y * view.scale;
      // Plan angles run anticlockwise with y up; on screen y points down, so the rotation reverses.
      const rad = (-anchor.angleDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const at = (x: number, y: number) => ({ x: sx + x * cos - y * sin, y: sy + x * sin + y * cos });
      // Every glyph stays inside GLYPH_REACH_PX, because that is how far the hit test reaches: draw
      // past it and the tip stops being pressable, which is the fault this pair of numbers exists to
      // prevent.
      if (kind === "arc") {
        // A bow standing off the wall, and nothing else: the bend this handle would put in it.
        //
        // No stalk. Two earlier versions had one, and both read wrong — a stem along the bow's own
        // axis made a three-pronged fork, and a stem across it showed through the curve as a tick
        // inside a C. The arc alone says "curve this", and with nothing to overlap there is no
        // arrangement of numbers left to get wrong.
        //
        // Sampled rather than drawn with arc(), so the shape cannot flip with the winding when the
        // wall's angle puts the sweep the other way round.
        const centre = 13;
        const radius = 10;
        ctx.beginPath();
        for (let i = 0; i <= 18; i += 1) {
          const a = -Math.PI / 2 + (i / 18) * Math.PI;
          const p = at(centre - Math.cos(a) * radius * 0.55, Math.sin(a) * radius);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        continue;
      }
      // An arrow pointing out of the wall: the direction pulling this end would take it.
      const tail = at(8, 0);
      const tip = at(22, 0);
      const left = at(15.5, -5);
      const right = at(15.5, 5);
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.moveTo(left.x, left.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(right.x, right.y);
      ctx.stroke();
    }
    ctx.restore();
  };

  el.plan.addEventListener("pointerdown", (e) => {
    // A handle of the selected wall beats everything else. The handles are drawn over the wall's own
    // ends, so a press that lands on one has to reshape rather than move the wall or pan the view.
    const shaped = handleWall();
    if (shaped) {
      const handle = handleAt(
        shaped,
        wallFootprintUnjoined(shaped),
        planPointOf(e),
        indicatorMarginMm(plan.view.scale, e.pointerType === "touch"),
        1 / plan.view.scale,
      );
      if (handle && replica.project) {
        // Both snapshots are the state the host last agreed to. The drag edits the local copy on every
        // move, so these are the only way back if the gesture changes nothing or the host refuses it.
        handling = {
          wallId: shaped.id,
          handle,
          before: shaped,
          beforeProject: replica.agreed ?? replica.project,
          preview: null,
        };
        el.plan.setPointerCapture(e.pointerId);
        return;
      }
    }
    // Then a handle of the selected item: resize or turn it rather than moving it.
    const target = handleItem();
    if (target && replica.project) {
      const at = planPointOf(e);
      const handle = itemHandleAt(target.item, target.size, at, 1 / plan.view.scale, target.resizable);
      if (handle) {
        itemHandling = {
          item: target.item,
          size: target.size,
          handle,
          from: at,
          beforeProject: replica.agreed ?? replica.project,
          commands: [],
        };
        el.plan.style.cursor = handle.kind === "rotate" ? "grabbing" : el.plan.style.cursor;
        el.plan.setPointerCapture(e.pointerId);
        return;
      }
    }
    // Pressing on an entity that is ALREADY selected moves the selection; pressing anywhere else still
    // pans. Requiring it to be selected first is what keeps panning usable: otherwise every press that
    // happened to land on a wall would drag it.
    const hit = plan.hitTest(planPointOf(e), SELECTION_PX / plan.view.scale);
    if (hit && replica.selection.includes(hit) && replica.project)
      moving = {
        fromX: e.clientX,
        fromY: e.clientY,
        ids: [...replica.selection],
        dx: 0,
        dy: 0,
        before: replica.agreed ?? replica.project,
      };
    drag = { x: e.clientX, y: e.clientY };
    el.plan.setPointerCapture(e.pointerId);
  });
  el.plan.addEventListener("pointermove", (e) => {
    if (itemHandling) {
      const active = itemHandling;
      const to = planPointOf(e);
      // Alt bypasses snapping, as everywhere else (W-082); Shift keeps a corner's proportions.
      const commands =
        active.handle.kind === "rotate"
          ? [rotateCommand(active.item, to, !e.altKey)].filter((c): c is ItemCommand => c !== null)
          : resizeCommands(active.item, active.size, active.handle, active.from, to, {
              snap: !e.altKey,
              keepRatio: e.shiftKey,
            });
      itemHandling = { ...active, commands };
      const local = commands.length > 0 ? applyLocally(active.beforeProject, commands) : null;
      if (local)
        replica.applyLocally(local.project, {
          commandType: "local.item-handle",
          added: [],
          updated: touchedByItem(active.beforeProject, active.item.id),
          removed: [],
        });
      else replica.restore();
      plan.invalidateOverlay();
      planDirty = true;
      return;
    }
    if (handling) {
      const active = handling;
      // Measured from the wall as it was when the press began, never from the wall as this drag has
      // already left it: reading back the edited copy would compound each move into the last and the
      // shape would run away from the pointer.
      // Alt bypasses snapping, which is what the tool options bar promises; for a bend, snapping means
      // whole degrees of arc (W-062).
      // A dragged end welds onto another wall's free end within the same 2 px the drawing tool uses to
      // join a new chain (W-068, W-069) — the same gesture should mean the same thing however the wall
      // got there. Alt turns magnetism off, as the tool options bar promises.
      const level = plan.level;
      const next = previewWall(active.before, active.handle, planPointOf(e), {
        snap: !e.altKey,
        walls: replica.project?.walls.filter((x) => x.levelId === level) ?? [],
        weldToleranceMm: e.altKey ? 0 : WALL_END_PX / plan.view.scale,
      });
      handling = { ...active, preview: next };
      // Through the REAL reducer, not by swapping the one wall. A reshaped end drags whatever is joined
      // to it along (W-031), and the neighbour has to move in the same frame or the corner tears open
      // and only closes when the button comes up. Running wall.modify locally gets that for free; the
      // swap it replaced knew about one wall and nothing it was attached to.
      //
      // Always from the project as it was at the press, so each move replaces the last rather than
      // compounding with it. One command goes to the host at the end, not one per pointer move.
      const reshape = next ? handleCommand(active.before, active.handle, next) : null;
      const local = reshape ? applyLocally(active.beforeProject, [reshape]) : null;
      if (local) replica.applyLocally(local.project, { ...local.changes, commandType: "local.reshape" });
      else replica.restore();
      plan.invalidateOverlay();
      planDirty = true;
      return;
    }
    if (moving) {
      // The view holds still while a selection is dragged; the entities themselves follow the pointer.
      // Measured from the project as it was at the press, never from the copy this drag has already
      // edited, or each move would compound into the last and the selection would run away.
      const active = moving;
      const { dx, dy } = deltaMm(active.fromX, active.fromY, e.clientX, e.clientY);
      moving = { ...active, dx, dy };
      const local = applyLocally(active.before, moveCommands(active.before, active.ids, dx, dy));
      if (local) replica.applyLocally(local.project, local.changes);
      plan.invalidateOverlay();
      planDirty = true;
      return;
    }
    if (!drag) {
      // Nothing is being dragged, so the pointer's job is to say what a press WOULD do: a resize arrow
      // on an end, a grab on the bend, a move over anything already selected. Without this there is no
      // way to tell a stretch from a drag until the wrong one has already started.
      const at = planPointOf(e);
      const shaped = handleWall();
      const fp = shaped ? wallFootprintUnjoined(shaped) : null;
      const hovered =
        shaped && fp
          ? handleAt(
              shaped,
              fp,
              at,
              indicatorMarginMm(plan.view.scale, e.pointerType === "touch"),
              1 / plan.view.scale,
            )
          : null;
      const target = hovered ? null : handleItem();
      const itemHovered = target
        ? itemHandleAt(target.item, target.size, at, 1 / plan.view.scale, target.resizable)
        : null;
      if (hovered && shaped && fp) {
        const anchors = handleAnchors(shaped, fp);
        el.plan.style.cursor = anchors ? handleCursor(hovered, anchors[hovered].angleDeg) : "pointer";
      } else if (itemHovered && target) {
        el.plan.style.cursor = itemHandleCursor(itemHovered, target.item.rotation);
      } else {
        const over = plan.hitTest(at, SELECTION_PX / plan.view.scale);
        el.plan.style.cursor = over && replica.selection.includes(over) ? "move" : "";
      }
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio);
    plan.panBy((e.clientX - drag.x) * dpr, (e.clientY - drag.y) * dpr);
    drag = { x: e.clientX, y: e.clientY };
    planDirty = true;
  });
  el.plan.addEventListener("pointerup", (e) => {
    if (itemHandling) {
      const done = itemHandling;
      itemHandling = null;
      drag = null;
      // Back to what the host agreed, then one entry in the history for the whole gesture: a resize that
      // keeps the far side put is two commands, and undoing it must take both.
      replica.restore();
      const [only] = done.commands;
      if (done.commands.length > 1)
        void client.transaction(done.handle.kind === "rotate" ? "Turn item" : "Resize item", done.commands);
      else if (only) void client.command(only);
      el.plan.style.cursor = "";
      plan.invalidateOverlay();
      planDirty = true;
      return;
    }
    if (handling) {
      const done = handling;
      handling = null;
      drag = null;
      // One command for the whole gesture, not one per move: the history should hold "this wall was
      // reshaped", not every intermediate position the pointer passed through.
      const command = done.preview ? handleCommand(done.before, done.handle, done.preview) : null;
      // The whole project back as the host last agreed it, not just the dragged wall: a reshape moves
      // whatever is joined to the end as well, and restoring one of them would strand the other where
      // the drag left it. The drag has been editing this copy without the host's knowledge, so leaving
      // any of it standing would keep a shape on screen that was never accepted if the command is
      // refused. The host's patch lands a moment later and puts the new shape back for real.
      replica.restore();
      if (command) void client.command(command);
      plan.invalidateOverlay();
      planDirty = true;
      return;
    }
    if (moving) {
      const moved = moving;
      moving = null;
      drag = null;
      const dxPx = e.clientX - moved.fromX;
      const dyPx = e.clientY - moved.fromY;
      // Under the 3 px threshold this was a click, not a drag: fall through to selection next time
      // rather than committing a move of nothing.
      const { dx, dy } = deltaMm(moved.fromX, moved.fromY, e.clientX, e.clientY);
      const commands = Math.hypot(dxPx, dyPx) >= 3 ? moveCommands(moved.before, moved.ids, dx, dy) : [];
      // Put everything back as the host last agreed before asking for the change. The drag has been
      // editing this copy without the host's knowledge, so leaving it standing would keep positions on
      // screen that were never accepted if a command is refused. The host's patch follows a moment later.
      replica.restore();
      for (const command of commands) void client.command(command);
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
    // A patch from the host took a preview away (Replica.applyChanges): show it again on the new state,
    // once this notification is over.
    if (previewing && !replica.showingLocal && !changes.commandType.startsWith("local."))
      queueMicrotask(() => {
        if (previewing && !replica.showingLocal) preview(previewing);
      });
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
  let lastScale = Number.NaN;
  const loop = () => {
    const sel = replica.selection.join(",");
    if (sel !== lastSelection) {
      lastSelection = sel;
      selectionPoll();
    }
    if (planDirty) {
      plan.flush();
      planDirty = false;
      // Checked here because every change to the view ends in a redraw, whatever caused it.
      if (plan.view.scale !== lastScale) {
        lastScale = plan.view.scale;
        el.onScale?.(lastScale);
      }
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
    preview,
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
      if (!project || !level) return;

      // A handle drag draws nothing here any more. It used to paint a dashed outline of the wall as it
      // would be, because the real one could not move until the host agreed; now the drag edits the
      // local copy on every move, so the wall itself follows the pointer and a second blue shape over
      // the top of it would only be in the way.
      if (handling) return;

      // A selection drag draws nothing here any more either. It used to paint each selected entity's
      // outline translated by the drag, because the entities themselves could not move until the host
      // agreed; now the drag runs the real reducer against the local copy on every move, so they do
      // move, and a dashed copy sitting on top of them would only be in the way.
      if (moving) return;

      // Nothing is being dragged, so show what CAN be: the handles on the one selected wall or item.
      // An item keeps its handles while one of them is dragged, so the pointer has something to hold.
      const shaped = handleWall();
      if (shaped) drawWallHandles(ctx, view, shaped);
      const target = handleItem();
      if (target) drawItemHandles(ctx, view, target);
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
