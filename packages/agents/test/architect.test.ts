// The architect (ADR-022 D1): a sub-run with its own context, its own six tools and a round budget.
//
// Scripted, so the tests are about the machinery and not about whether a particular model designs
// well: that the drawing tools are unreachable, that only the design comes back, that the parent's
// conversation is untouched, and that a budget spent ends in an explanation rather than in silence.
import { CORE_RULES } from "@fpv/catalog";
import { createStore } from "@fpv/commands";
import { sequentialIdGenerator } from "@fpv/ir";
import { blankProject, catalogSourceOf, createRegistry, memoryCatalog, type Registry } from "@fpv/tools";
import { describe, expect, it } from "vitest";
import {
  ARCHITECT_TOOLS,
  architectSystem,
  type Completion,
  type CompletionRequest,
  type Provider,
  runArchitect,
  type ToolCall,
} from "../src/index.js";

const usage = { promptTokens: 10, completionTokens: 5 };
const reply = (text: string | null, toolCalls: ToolCall[] = []): Completion => ({
  text,
  toolCalls,
  finishReason: toolCalls.length ? "tool_calls" : "stop",
  usage,
  raw: null,
});
const call = (name: string, args: unknown, id = `c_${name}`): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

function scripted(steps: ((req: CompletionRequest) => Completion)[]): Provider & {
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  let i = 0;
  return {
    id: "fake",
    model: "fake-1",
    profile: {
      vision: false,
      toolCalls: true,
      toolReliability: "high",
      contextTokens: 32000,
      jsonMode: false,
    },
    requests,
    async complete(req) {
      requests.push({ ...req, messages: [...req.messages] });
      const step = steps[Math.min(i, steps.length - 1)] as (r: CompletionRequest) => Completion;
      i += 1;
      return step(req);
    },
  };
}

function session(): Registry {
  const now = () => "2026-09-20T00:00:00.000Z";
  const catalog = memoryCatalog([]);
  const store = createStore(blankProject("t", now(), "architect000"), {
    ids: sequentialIdGenerator(1),
    now,
    catalog: catalogSourceOf(catalog, now),
  });
  return createRegistry({
    store,
    catalog,
    viewer: null,
    files: null,
    verifier: null,
    rules: CORE_RULES,
    writer: null,
    transcript: null,
    now,
  } as never);
}

/** A two-room design that passes the checker: a studio with a bathroom off it. */
const GOOD = {
  brief: "a studio",
  kind: "dwelling",
  shell: { x: 0, y: 0, w: 6000, d: 5000, wallMm: 230, interiorWallMm: 115 },
  rooms: [
    {
      key: "main",
      name: "Studio",
      purpose: "living",
      rect: { x: 0, y: 0, w: 6000, d: 3000 },
      doorsTo: ["outside", "bath", "kitchen"],
      window: true,
    },
    {
      key: "kitchen",
      name: "Kitchen",
      purpose: "kitchen",
      rect: { x: 0, y: 3100, w: 3400, d: 1900 },
      doorsTo: ["main"],
      window: true,
    },
    {
      key: "bath",
      name: "Bathroom",
      purpose: "bathroom",
      rect: { x: 3500, y: 3100, w: 2500, d: 1900 },
      doorsTo: ["main"],
    },
  ],
  circulation: [],
  assumptions: ["a studio has no separate bedroom"],
};
/** The same, with a bedroom too small to be one. */
const BAD = {
  ...GOOD,
  rooms: [
    ...GOOD.rooms,
    {
      key: "bed",
      name: "Bedroom",
      purpose: "bedroom",
      rect: { x: 0, y: 3100, w: 1200, d: 1200 },
      doorsTo: ["main"],
    },
  ],
};

describe("the architect's reach", () => {
  it("is six tools, none of which draws", () => {
    expect([...ARCHITECT_TOOLS].sort()).toEqual([
      "check_design",
      "describe_room",
      "get_scene",
      "measure",
      "plan_rooms",
      "search_catalog",
    ]);
    for (const drawing of ["create_walls", "build_design", "place_item", "furnish_room", "add_opening"])
      expect(ARCHITECT_TOOLS.has(drawing), drawing).toBe(false);
  });

  it("refuses a drawing tool even when the model asks for one", async () => {
    const registry = session();
    const seen: string[] = [];
    const provider = scripted([
      () => reply(null, [call("create_walls", { levelId: "level_000000", points: [], closed: true })]),
      (req) => {
        seen.push(String(req.messages.at(-1)?.content));
        return reply(null, [call("check_design", { design: GOOD })]);
      },
      () => reply("Designed a studio. designId is in the check."),
    ]);
    const result = await runArchitect(provider, registry, { role: "architect", brief: "a studio" });
    expect(seen[0]).toMatch(/tool.not-granted/);
    expect(seen[0]).toMatch(/create_walls is not one of the tools this step may use/);
    expect(registry.ctx.store.project.walls).toHaveLength(0);
    expect(result.designId).toMatch(/^design_/);
  });

  it("is advertised only the tools it may use, which is most of what a step costs", () => {
    const registry = session();
    const provider = scripted([() => reply("done")]);
    void provider;
    const all = registry.advertised("high").length;
    const mine = registry.advertised("high").filter((t) => ARCHITECT_TOOLS.has(t.name)).length;
    expect(mine).toBe(6);
    expect(all).toBeGreaterThan(25);
  });
});

describe("what comes back", () => {
  it("is the design it settled on and its own words, not its working", async () => {
    const registry = session();
    const provider = scripted([
      () => reply(null, [call("get_scene", { detail: "summary" })]),
      () => reply(null, [call("check_design", { design: GOOD })]),
      () => reply("A 6 by 5 m studio with a kitchen and a bathroom off it."),
    ]);
    const result = await runArchitect(provider, registry, { role: "architect", brief: "a studio" });
    expect(result.designId).toMatch(/^design_/);
    expect(result.text).toBe("A 6 by 5 m studio with a kitchen and a bathroom off it.");
    expect(result.unresolved).toEqual([]);
    expect(result.rounds).toBe(1);
    expect(result.reason).toBe("done");
  });

  it("starts from an empty conversation, so nothing of the caller's rides along", async () => {
    const registry = session();
    const provider = scripted([
      () => reply(null, [call("check_design", { design: GOOD })]),
      () => reply("done"),
    ]);
    await runArchitect(provider, registry, { role: "architect", brief: "a studio" });
    const first = provider.requests[0] as CompletionRequest;
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({ role: "user", content: "a studio" });
    expect(first.system).toBe(architectSystem());
  });

  it("keeps checking until one passes, and reports the round it took", async () => {
    const registry = session();
    const provider = scripted([
      () => reply(null, [call("check_design", { design: BAD })]),
      () => reply(null, [call("check_design", { design: GOOD })]),
      () => reply("Fixed the bedroom by taking it out; it is a studio."),
    ]);
    const result = await runArchitect(provider, registry, { role: "architect", brief: "a studio" });
    expect(result.rounds).toBe(2);
    expect(result.designId).toMatch(/^design_/);
    expect(result.unresolved).toEqual([]);
  });
});

describe("when it cannot get there", () => {
  it("spends its rounds, is told to stop, and hands back what it could not fix", async () => {
    const registry = session();
    const provider = scripted([
      () => reply(null, [call("check_design", { design: BAD })]),
      () => reply("I could not make the bedroom large enough inside a 6 by 5 m shell."),
    ]);
    const result = await runArchitect(
      provider,
      registry,
      { role: "architect", brief: "a studio" },
      {
        maxRounds: 1,
      },
    );
    expect(result.designId).toBeNull();
    expect(result.unresolved.join(" ")).toMatch(/Bedroom is 1.4 m²/);
    expect(result.text).toMatch(/could not make the bedroom large enough/);
  });

  it("refuses a further check once the rounds are spent, and says to answer", async () => {
    const registry = session();
    const seen: string[] = [];
    const provider = scripted([
      () => reply(null, [call("check_design", { design: BAD })]),
      () => reply(null, [call("check_design", { design: BAD }, "again")]),
      (req) => {
        seen.push(String(req.messages.at(-1)?.content));
        return reply("Giving up: the bedroom cannot fit.");
      },
    ]);
    const result = await runArchitect(
      provider,
      registry,
      { role: "architect", brief: "a studio" },
      {
        maxRounds: 1,
      },
    );
    expect(seen[0]).toMatch(/design.rounds-spent/);
    expect(seen[0]).toMatch(/there are no more rounds/);
    expect(result.rounds).toBe(1);
    expect(result.designId).toBeNull();
  });
});
