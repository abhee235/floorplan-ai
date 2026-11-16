// The code sandbox (ADR-030): JavaScript the model writes, run in QuickJS compiled to WebAssembly.
//
// Inside it there is nothing but what is installed below -- no file system, no network, no timers, no
// require, no host objects. Each sandbox has its own WebAssembly module, so one session's suspended
// tool call never waits on another's, and its own runtime with a memory limit and an interrupt hook
// that enforces the time limit.
//
// A sandbox keeps its globals between calls, like a REPL (D2). `tools.call` is synchronous from the
// script's side: the engine is asyncified, so the script is suspended while the host runs the tool and
// resumed with its result. That is what lets a model write a loop over ninety-one items without
// learning about promises -- and why `await` at the top of a script is answered with a hint instead.

import {
  newQuickJSAsyncWASMModule,
  type QuickJSAsyncContext,
  type QuickJSAsyncRuntime,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { type CropOptions, crop, decodeGray, draw, type Gray, type Mark, type Picture } from "./pictures.js";
import { type Measured, scaleFrom } from "./scale.js";

/** What the sandbox may reach on the host; every call is checked there, not here (D4). */
export interface SandboxHost {
  attachments(): { id: string; name: string; mime: string; size: number }[];
  attachmentBytes(id: string): Uint8Array | null;
  project(): unknown;
  callTool(name: string, args: unknown): Promise<{ ok: boolean; error?: { code: string; message: string } }>;
}

export interface SandboxLimits {
  /** Milliseconds of running time per call, not counting time spent in tool calls. */
  timeMs: number;
  memoryBytes: number;
  toolCalls: number;
  pictures: number;
  printedChars: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  timeMs: 30_000,
  memoryBytes: 256 * 1024 * 1024,
  toolCalls: 500,
  pictures: 4,
  printedChars: 16_000,
};

export interface ShownPicture extends Picture {
  caption: string;
}

export interface RunOutput {
  ok: boolean;
  /** What console.log printed, cut at the limit with a note. */
  printed: string;
  /** The value of the script's last expression, as JSON would have it. */
  value: unknown;
  error: string | null;
  pictures: ShownPicture[];
  calls: { name: string; ok: boolean; error?: string }[];
  ms: number;
}

/** Errors the model can act on, said the way it will understand them. */
function explain(error: { name?: string; message?: string } | string, code = ""): string {
  const e = typeof error === "string" ? { message: error } : error;
  const text = `${e.name ? `${e.name}: ` : ""}${e.message ?? String(error)}`;
  // QuickJS reports a top-level await as a plain syntax error, so the code is what gives it away.
  if (/SyntaxError/.test(text) && /\bawait\b/.test(code))
    return `${text} -- tools.call is synchronous here: drop the await and use its result directly`;
  if (/interrupted/i.test(text))
    return `${text} -- the script ran past its time limit; do less per call and keep what you have in globals`;
  if (/await is only valid|unexpected.*await|await.*reserved/i.test(text))
    return `${text} -- tools.call is synchronous here: drop the await and use its result directly`;
  if (/out of memory/i.test(text))
    return `${text} -- the sandbox ran out of memory; work on a smaller region`;
  if (/redeclaration|already been declared/i.test(text))
    return `${text} -- globals survive between calls; assign to the existing name, or use var`;
  return text;
}

export class Sandbox {
  lastUsed = Date.now();
  private readonly images = new Map<string, Gray>();
  private readonly made = new Map<string, Picture>();
  private seq = 0;
  private busy: Promise<unknown> = Promise.resolve();
  /** The call in progress, which the installed functions write to. */
  private current: {
    host: SandboxHost;
    limits: SandboxLimits;
    printed: string[];
    printedChars: number;
    pictures: ShownPicture[];
    calls: RunOutput["calls"];
    deadline: number;
    lastMade: string | null;
  } | null = null;

  private constructor(
    private readonly runtime: QuickJSAsyncRuntime,
    private readonly vm: QuickJSAsyncContext,
  ) {}

  static async create(limits: SandboxLimits = DEFAULT_LIMITS): Promise<Sandbox> {
    const module = await newQuickJSAsyncWASMModule();
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(1024 * 1024);
    const vm = runtime.newContext();
    const sandbox = new Sandbox(runtime, vm);
    runtime.setInterruptHandler(() => (sandbox.current ? Date.now() > sandbox.current.deadline : false));
    sandbox.install();
    return sandbox;
  }

  /**
   * Free the engine. Each sandbox owns its WebAssembly module, so when QuickJS objects to the order
   * its host references are freed in, dropping the references is enough: the module goes with them.
   */
  dispose(): void {
    try {
      this.vm.dispose();
      this.runtime.dispose();
    } catch {
      // see above
    }
  }

  /** Run one script. Calls on one sandbox are taken one at a time, in order. */
  run(code: string, host: SandboxHost, limits: SandboxLimits = DEFAULT_LIMITS): Promise<RunOutput> {
    const next = this.busy.then(() => this.runNow(code, host, limits));
    this.busy = next.catch(() => undefined);
    return next;
  }

  private async runNow(code: string, host: SandboxHost, limits: SandboxLimits): Promise<RunOutput> {
    const started = Date.now();
    this.lastUsed = started;
    this.current = {
      host,
      limits,
      printed: [],
      printedChars: 0,
      pictures: [],
      calls: [],
      deadline: started + limits.timeMs,
      lastMade: null,
    };
    const cur = this.current;
    let value: unknown = null;
    let error: string | null = null;
    try {
      const result = await this.vm.evalCodeAsync(code, "run_code.js");
      if (result.error) {
        error = explain(this.vm.dump(result.error) as { name?: string; message?: string }, code);
        result.error.dispose();
      } else {
        value = this.vm.dump(result.value);
        result.value.dispose();
      }
    } catch (e) {
      error = explain(e instanceof Error ? e.message : String(e));
    } finally {
      this.current = null;
    }
    // A picture made and never shown is almost always one the model meant to look at.
    if (cur.pictures.length === 0 && cur.lastMade) {
      const pic = this.made.get(cur.lastMade);
      if (pic) cur.pictures.push({ ...pic, caption: "The last picture this script made." });
    }
    this.lastUsed = Date.now();
    return {
      ok: error === null,
      printed: cur.printed.join("\n"),
      value: value === undefined ? null : value,
      error,
      pictures: cur.pictures,
      calls: cur.calls,
      ms: Date.now() - started,
    };
  }

  // ---- what the script can reach ---------------------------------------------------------------

  private toGuest(value: unknown): QuickJSHandle {
    const vm = this.vm;
    if (value === undefined) return vm.undefined;
    const text = vm.newString(JSON.stringify(value));
    const json = vm.getProp(vm.global, "JSON");
    const parse = vm.getProp(json, "parse");
    const out = vm.unwrapResult(vm.callFunction(parse, vm.undefined, text));
    text.dispose();
    parse.dispose();
    json.dispose();
    return out;
  }

  /** A guest object `{ ...meta, gray: Uint8Array }` for a decoded picture. */
  private imageToGuest(key: string, img: Gray): QuickJSHandle {
    const vm = this.vm;
    const obj = this.toGuest({ handle: key, width: img.width, height: img.height, scale: img.scale });
    const buf = vm.newArrayBuffer(img.gray.slice().buffer);
    const make = vm.getProp(vm.global, "__u8");
    const arr = vm.unwrapResult(vm.callFunction(make, vm.undefined, buf));
    vm.setProp(obj, "gray", arr);
    arr.dispose();
    buf.dispose();
    make.dispose();
    return obj;
  }

  /** The key of a picture argument: the object an earlier call returned, or its handle string. */
  private keyOf(arg: QuickJSHandle | undefined): string {
    if (!arg) throw new Error("give a picture: the object image(), crop() or draw() returned");
    if (this.vm.typeof(arg) === "string") return this.vm.getString(arg);
    const h = this.vm.getProp(arg, "handle");
    const key = this.vm.typeof(h) === "string" ? this.vm.getString(h) : "";
    h.dispose();
    if (!key) throw new Error("that is not a picture: pass what image(), crop() or draw() returned");
    return key;
  }

  private remember(pic: Picture): string {
    this.seq += 1;
    const key = `pic${this.seq}`;
    this.made.set(key, pic);
    // Only the newest few are kept; a picture is cheap to make again.
    if (this.made.size > 12) this.made.delete(this.made.keys().next().value as string);
    if (this.current) this.current.lastMade = key;
    return key;
  }

  private install(): void {
    const vm = this.vm;
    const need = () => {
      if (!this.current) throw new Error("the sandbox is not running a call");
      return this.current;
    };
    const fn = (name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle | undefined) => {
      const h = vm.newFunction(name, (...args) => {
        try {
          return impl(...args);
        } catch (e) {
          return { error: vm.newError(e instanceof Error ? e.message : String(e)) };
        }
      });
      return h;
    };
    vm.unwrapResult(vm.evalCode("globalThis.__u8 = (b) => new Uint8Array(b);")).dispose();

    const consoleObj = vm.newObject();
    const log = fn("log", (...args) => {
      const cur = need();
      const line = args
        .map((a) => {
          const v = vm.dump(a);
          const s = typeof v === "string" ? v : JSON.stringify(v);
          return s && s.length > 4000 ? `${s.slice(0, 4000)} ...[cut]` : s;
        })
        .join(" ");
      if (cur.printedChars < cur.limits.printedChars) {
        const room = cur.limits.printedChars - cur.printedChars;
        cur.printed.push(
          line.length > room ? `${line.slice(0, room)} ...[printing stopped at the limit]` : line,
        );
        cur.printedChars += line.length + 1;
      }
      return undefined;
    });
    vm.setProp(consoleObj, "log", log);
    vm.setProp(vm.global, "console", consoleObj);
    log.dispose();
    consoleObj.dispose();

    const list = fn("attachments", () => this.toGuest(need().host.attachments()));
    vm.setProp(vm.global, "attachments", list);
    list.dispose();

    const project = fn("project", () => this.toGuest(need().host.project()));
    vm.setProp(vm.global, "project", project);
    project.dispose();

    const scale = fn("scaleFrom", (listArg) =>
      this.toGuest(scaleFrom((listArg ? vm.dump(listArg) : []) as Measured[])),
    );
    vm.setProp(vm.global, "scaleFrom", scale);
    scale.dispose();

    const image = fn("image", (idArg) => {
      const id = idArg && vm.typeof(idArg) === "string" ? vm.getString(idArg) : "";
      if (!id) throw new Error('give an attachment id, e.g. image("a1")');
      let img = this.images.get(id);
      if (!img) {
        const bytes = need().host.attachmentBytes(id);
        if (!bytes) throw new Error(`no attachment "${id}"; attachments() lists them`);
        img = decodeGray(bytes);
        this.images.set(id, img);
      }
      return this.imageToGuest(id, img);
    });
    vm.setProp(vm.global, "image", image);
    image.dispose();

    const source = (key: string): Gray => {
      const img = this.images.get(key);
      if (!img) throw new Error(`"${key}" is not a decoded picture; call image(id) first`);
      return img;
    };

    const cropFn = fn("crop", (imgArg, optsArg) => {
      const img = source(this.keyOf(imgArg));
      const o = (optsArg ? vm.dump(optsArg) : {}) as CropOptions;
      const pic = crop(img, o);
      const key = this.remember(pic);
      return this.toGuest({
        handle: key,
        width: pic.width,
        height: pic.height,
        region: pic.region,
        scale: pic.scale,
        grid: pic.grid,
      });
    });
    vm.setProp(vm.global, "crop", cropFn);
    cropFn.dispose();

    const drawFn = fn("draw", (imgArg, marksArg, scaleArg) => {
      const img = source(this.keyOf(imgArg));
      const marks = (marksArg ? vm.dump(marksArg) : []) as Mark[];
      if (!Array.isArray(marks))
        throw new Error("marks is a list: [{ line: [x1,y1,x2,y2], colour: 'red' }, ...]");
      const scale = scaleArg && vm.typeof(scaleArg) === "number" ? vm.getNumber(scaleArg) : undefined;
      const pic = draw(img, marks, scale);
      const key = this.remember(pic);
      return this.toGuest({ handle: key, width: pic.width, height: pic.height, scale: pic.scale });
    });
    vm.setProp(vm.global, "draw", drawFn);
    drawFn.dispose();

    const show = fn("show", (picArg, captionArg) => {
      const cur = need();
      const key = this.keyOf(picArg);
      // show("a1") and show(image("a1")) mean the whole picture. Three of four live runs wrote one of
      // them, the script stopped there, and the model went on without the look it had asked for.
      let pic = this.made.get(key);
      if (!pic) {
        let img = this.images.get(key);
        const bytes = img ? undefined : cur.host.attachmentBytes(key);
        if (bytes) {
          img = decodeGray(bytes);
          this.images.set(key, img);
        }
        if (img) pic = crop(img, {});
      }
      if (!pic)
        throw new Error(
          `"${key}" is not a picture; show what crop() or draw() returned, or an attachment id`,
        );
      if (cur.pictures.length >= cur.limits.pictures)
        throw new Error(`at most ${cur.limits.pictures} pictures a call; look at these first`);
      const caption = captionArg && vm.typeof(captionArg) === "string" ? vm.getString(captionArg) : "";
      cur.pictures.push({ ...pic, caption });
      return undefined;
    });
    vm.setProp(vm.global, "show", show);
    show.dispose();

    const toolsObj = vm.newObject();
    const callFn = vm.newAsyncifiedFunction("call", async (nameArg, argsArg) => {
      const cur = need();
      const name = nameArg && vm.typeof(nameArg) === "string" ? vm.getString(nameArg) : "";
      if (!name)
        return {
          error: vm.newError('give a tool name, e.g. tools.call("get_scene", { detail: "summary" })'),
        };
      if (name === "run_code") return { error: vm.newError("run_code cannot call itself") };
      if (cur.calls.length >= cur.limits.toolCalls)
        return { error: vm.newError(`at most ${cur.limits.toolCalls} tool calls a script; split the work`) };
      const args = argsArg ? vm.dump(argsArg) : {};
      // Time in the tool is the tool's, not the script's.
      const before = Date.now();
      const env = await cur.host.callTool(name, args ?? {});
      cur.deadline += Date.now() - before;
      cur.calls.push({ name, ok: env.ok, ...(env.ok ? {} : { error: env.error?.message ?? "failed" }) });
      return this.toGuest(env);
    });
    vm.setProp(toolsObj, "call", callFn);
    vm.setProp(vm.global, "tools", toolsObj);
    callFn.dispose();
    toolsObj.dispose();
  }
}

/**
 * The sandboxes of the sessions that have one, keyed by whatever identifies a session (its store),
 * and dropped after fifteen idle minutes (D2).
 */
export class Sandboxes {
  private readonly held = new WeakMap<object, Sandbox>();
  private readonly live = new Set<{ key: WeakRef<object>; box: Sandbox }>();
  constructor(private readonly idleMs = 15 * 60_000) {}

  /** The session's sandbox, and whether it was just made (so the model knows its globals are gone). */
  async of(key: object, reset = false): Promise<{ box: Sandbox; fresh: boolean }> {
    this.sweep();
    const had = this.held.get(key);
    if (had && !reset) return { box: had, fresh: false };
    if (had) this.drop(key, had);
    const box = await Sandbox.create();
    this.held.set(key, box);
    this.live.add({ key: new WeakRef(key), box });
    return { box, fresh: true };
  }

  private drop(key: object, box: Sandbox): void {
    box.dispose();
    this.held.delete(key);
    for (const e of this.live) if (e.box === box) this.live.delete(e);
  }

  private sweep(): void {
    const now = Date.now();
    for (const e of [...this.live]) {
      const key = e.key.deref();
      if (!key || now - e.box.lastUsed > this.idleMs) {
        e.box.dispose();
        if (key) this.held.delete(key);
        this.live.delete(e);
      }
    }
  }
}
