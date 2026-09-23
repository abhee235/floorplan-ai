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
  it("is eleven tools, none of which draws", () => {
    // look_at joined in ADR-027 D3: a picture the person attached, which the architect never saw.
    // preview_design in ADR-028 D11: a picture of its own design, before it calls it done.
    expect([...ARCHITECT_TOOLS].sort()).toEqual([
      "check_design",
      "describe_room",
      "get_scene",
      "look_at",
      "measure",
      "plan_rooms",
      "preview_design",
      "query_design",
      "revise_design",
      "search_catalog",
      "tidy_design",
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
    expect(mine).toBe(11);
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
      (req) => {
        const id = /design_[0-9a-z]+/.exec(JSON.stringify(req.messages.at(-1)?.content))?.[0] ?? "?";
        return reply(null, [call("revise_design", { designId: id, remove: ["bed"] })]);
      },
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

describe("the architect draws (ADR-028 D1, D9)", () => {
  it("is told to write the design itself, and no longer told not to", () => {
    const plain = architectSystem();
    expect(plain).toMatch(/The design is yours to draw/);
    expect(plain).toMatch(/plan_rooms is a helper for a quick first draft/);
    expect(plain).toMatch(/walled, glass or open/);
    expect(plain).toMatch(/query_design/);
    expect(plain).not.toMatch(/Do not place rectangles yourself/);
    expect(plain).not.toMatch(/Copying a picture/);
  });

  it("says how to copy a picture when one is attached", () => {
    const withPicture = architectSystem({ attachments: true });
    expect(withPicture).toMatch(/Copying a picture/);
    expect(withPicture).toMatch(/do not let plan_rooms rearrange it/);
    expect(withPicture).toMatch(/look_at it, with its id/);
  });
});

describe("the look gate (ADR-028 D11)", () => {
  const lastText = (req: CompletionRequest): string => {
    const content = req.messages.at(-1)?.content;
    return typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => (p.type === "text" ? p.text : "")).join(" ")
        : "";
  };
  const idIn = (text: string) => /design_[0-9a-z]+/.exec(text)?.[0] ?? "design_?";

  it("has a model that can see look at the design and judge it before it may answer", async () => {
    const registry = session();
    const told: string[] = [];
    let pictured = false;
    const provider = scripted([
      () => reply(null, [call("check_design", { design: GOOD })]),
      () => reply("Designed a studio."),
      (req) => {
        told.push(lastText(req));
        return reply(null, [call("preview_design", { designId: idIn(lastText(req)) })]);
      },
      (req) => {
        pictured = req.messages.some(
          (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
        );
        told.push(lastText(req));
        return reply(
          `LOOK ${idIn(lastText(req))}\n- Way in: from the south into the studio\n- Verdict: DONE`,
        );
      },
    ]);
    provider.profile.vision = true;
    const result = await runArchitect(provider, registry, { role: "architect", brief: "a studio" });
    expect(told[0]).toMatch(/look at it: call preview_design/);
    expect(pictured).toBe(true);
    // the picture comes with its checklist, not a bare "look at it"
    expect(told[1]).toMatch(/Write the LOOK verdict/);
    expect(result.looked).toBe(true);
    expect(result.verdict).toMatch(/^LOOK design_.*Verdict: DONE$/s);
    expect(result.designId).toMatch(/^design_/);
  });

  it("has a model that cannot see write the verdict from the walk, and is never offered the picture", async () => {
    const registry = session();
    const told: string[] = [];
    const provider = scripted([
      () => reply(null, [call("check_design", { design: GOOD })]),
      () => reply("Designed a studio."),
      (req) => {
        told.push(lastText(req));
        return reply(`LOOK ${idIn(lastText(req))}\n- Sides: the studio along the south\n- Verdict: DONE`);
      },
    ]);
    const result = await runArchitect(provider, registry, { role: "architect", brief: "a studio" });
    expect(provider.requests[0]?.tools?.map((t) => t.name)).not.toContain("preview_design");
    expect(told[0]).toMatch(/judge it/);
    expect(told[0]).toMatch(/- Displays:/);
    expect(result.looked).toBe(true);
  });

  it("asks twice, then lets the answer go marked as not looked at", async () => {
    const registry = session();
    const provider = scripted([
      () => reply(null, [call("check_design", { design: GOOD })]),
      () => reply("Designed a studio."),
    ]);
    provider.profile.vision = true;
    const result = await runArchitect(provider, registry, { role: "architect", brief: "a studio" });
    expect(result.designId).toMatch(/^design_/);
    expect(result.looked).toBe(false);
    // one check, then the answer three times: twice held back, the third let through
    expect(provider.requests).toHaveLength(4);
  });

  it("will not show the same picture twice", async () => {
    const registry = session();
    const seen: string[] = [];
    let id = "";
    const provider = scripted([
      () => reply(null, [call("check_design", { design: GOOD })]),
      (req) => {
        id = idIn(JSON.stringify(req.messages.at(-1)?.content));
        return reply(null, [call("preview_design", { designId: id }, "p1")]);
      },
      () => reply(null, [call("preview_design", { designId: id }, "p2")]),
      (req) => {
        seen.push(lastText(req));
        return reply(`LOOK ${id}\n- Verdict: DONE`);
      },
    ]);
    provider.profile.vision = true;
    await runArchitect(provider, registry, { role: "architect", brief: "a studio" });
    expect(seen[0]).toMatch(/already looked at/);
  });
});

describe("an answer with no design behind it (ADR-028 D11)", () => {
  it("is sent back twice, and then stands", async () => {
    const registry = session();
    const told: string[] = [];
    const provider = scripted([
      () => reply(null, [call("get_scene", { detail: "summary" })]),
      (req) => {
        const c = req.messages.at(-1)?.content;
        if (typeof c === "string" && c.includes("not checked a design")) told.push(c);
        return reply("I have read the skill and will write my notes.");
      },
    ]);
    const result = await runArchitect(provider, registry, { role: "architect", brief: "a studio" });
    expect(told).toHaveLength(2);
    expect(told[0]).toContain("call check_design");
    expect(result.designId).toBeNull();
    expect(result.rounds).toBe(0);
  });
});

describe("a design sent whole, twice (ADR-028 D10)", () => {
  it("is refused with the patch to send instead, and a different building is not", async () => {
    const registry = session();
    const told: string[] = [];
    const other = {
      ...GOOD,
      rooms: GOOD.rooms.map((r, i) => ({
        ...r,
        key: `z${i}`,
        doorsTo: r.doorsTo.map((d) => (d === "outside" ? d : `z${GOOD.rooms.findIndex((x) => x.key === d)}`)),
      })),
    };
    const provider = scripted([
      () => reply(null, [call("check_design", { design: GOOD }, "c1")]),
      () => reply(null, [call("check_design", { design: { ...GOOD, brief: "the same rooms again" } }, "c2")]),
      (req) => {
        told.push(String(req.messages.at(-1)?.content));
        return reply(null, [call("check_design", { design: other }, "c3")]);
      },
      (req) => {
        told.push(String(req.messages.at(-1)?.content));
        return reply("LOOK design\n- Verdict: DONE");
      },
    ]);
    await runArchitect(provider, registry, { role: "architect", brief: "a studio" });
    expect(told[0]).toContain("design.send-the-change");
    expect(told[0]).toContain("revise_design");
    // a design of different rooms goes through
    expect(told[1]).not.toContain("send-the-change");
  });
});
