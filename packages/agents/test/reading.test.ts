// What the model reads before it designs (ADR-027): skills, its own notes, a picture on demand, and a
// plan that belongs to the run that wrote it.
//
// The two runs behind these: one drew a classroom of a hundred desks because nothing had told it
// what an office is; the next was told by the plan gate to carry on furnishing that office after a
// different message had asked what a logo was.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  applyNotes,
  type ChatMessage,
  type Completion,
  type CompletionRequest,
  DEFAULT_PROFILE,
  loadSkills,
  NOTES_MAX_CHARS,
  type Provider,
  ProviderError,
  parseFrontmatter,
  readSkill,
  runAgent,
  UNREADABLE_REPLIES,
} from "../src/index.js";

const reply = (
  text: string | null,
  calls: { id: string; name: string; args: unknown }[] = [],
): Completion => ({
  text,
  toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args) })),
  finishReason: calls.length ? "tool_calls" : "stop",
  usage: { promptTokens: 1, completionTokens: 1 },
  raw: null,
});

function scripted(
  steps: ((req: CompletionRequest) => Completion)[],
  profile = {},
): Provider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  let i = 0;
  return {
    id: "fake",
    model: "fake-1",
    profile: { ...DEFAULT_PROFILE, ...profile },
    requests,
    async complete(req) {
      requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) as ChatMessage[] });
      const step = steps[Math.min(i, steps.length - 1)] as (r: CompletionRequest) => Completion;
      i += 1;
      return step(req);
    },
  };
}

const tools = [
  { name: "create_walls", description: "walls", parameters: { type: "object", properties: {} } },
  { name: "look_at", description: "a picture", parameters: { type: "object", properties: {} } },
];
const base = {
  tools,
  system: "sys",
  task: "build something",
  callTool: async () => ({ ok: true, result: {}, warnings: [] }),
  sleep: async () => {},
};

const SKILL = (description: string, body = "# Office\n\nBenches of six.") =>
  `---\nname: office-layout\ndescription: ${description}\nwhenToUse: before designing a workplace\n---\n${body}\n`;

function skillDirs(): { a: string; b: string } {
  const root = mkdtempSync(join(tmpdir(), "fpv-skills-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(join(a, "office-layout", "reference"), { recursive: true });
  writeFileSync(join(a, "office-layout", "SKILL.md"), SKILL("built in"));
  writeFileSync(
    join(a, "office-layout", "reference", "rooms.md"),
    "# Rooms\n\nA cafeteria is 1.3 m2 a seat.\n",
  );
  mkdirSync(join(a, "broken"), { recursive: true });
  writeFileSync(join(a, "broken", "SKILL.md"), "---\nname: broken\n---\n");
  writeFileSync(join(a, "stray.md"), "not a skill");
  mkdirSync(join(b, "office-layout"), { recursive: true });
  writeFileSync(
    join(b, "office-layout", "SKILL.md"),
    SKILL("the installation's own", "# Mine\n\nOverrides."),
  );
  mkdirSync(join(b, "home-layout"), { recursive: true });
  writeFileSync(join(b, "home-layout", "SKILL.md"), "# Home layout\n\nThree zones.\n");
  return { a, b };
}

describe("skills on disk (ADR-026 D3)", () => {
  it("reads a directory of SKILL.md files, and a later directory shadows an earlier one by name", () => {
    const { a, b } = skillDirs();
    const built = loadSkills([a]);
    expect(built.map((s) => s.name)).toEqual(["office-layout"]);
    expect(built[0]?.description).toBe("built in");
    expect(built[0]?.whenToUse).toBe("before designing a workplace");
    expect(Object.keys(built[0]?.references ?? {})).toEqual(["reference/rooms.md"]);

    const both = loadSkills([a, b, join(a, "does-not-exist")]);
    expect(both.map((s) => s.name).sort()).toEqual(["home-layout", "office-layout"]);
    expect(both.find((s) => s.name === "office-layout")?.description).toBe("the installation's own");
    // a file without frontmatter is still a skill, named after its directory and described by its heading
    expect(both.find((s) => s.name === "home-layout")?.description).toBe("Home layout");
    // and a skill with no body is not a skill; it is skipped rather than fatal
    expect(both.some((s) => s.name === "broken")).toBe(false);
  });

  it("parses a flat frontmatter block and nothing more", () => {
    expect(parseFrontmatter("---\nname: x\nDescription:  y \n---\nbody")).toEqual({
      meta: { name: "x", description: "y" },
      body: "body",
    });
    expect(parseFrontmatter("no block\n")).toEqual({ meta: {}, body: "no block" });
  });

  it("answers read_skill with the body, a reference on request, and the real names on a wrong one", () => {
    const skills = loadSkills([skillDirs().a]);
    const ok = readSkill(skills, { name: "Office-Layout" });
    expect(ok.ok).toBe(true);
    expect((ok as { result: { text: string; references: string[] } }).result).toMatchObject({
      text: "# Office\n\nBenches of six.",
      references: ["reference/rooms.md"],
    });
    const ref = readSkill(skills, { name: "office-layout", file: "reference/rooms.md" });
    expect((ref as { result: { text: string } }).result.text).toContain("1.3 m2 a seat");
    const wrong = readSkill(skills, { name: "hospital" });
    expect(wrong.ok).toBe(false);
    expect((wrong as { error: { hint: string } }).error.hint).toBe("the skills are: office-layout");
    const noRef = readSkill(skills, { name: "office-layout", file: "reference/nope.md" });
    expect((noRef as { error: { hint: string } }).error.hint).toContain("reference/rooms.md");
  });

  it("is offered as a tool only when there are skills, and the registry never sees the call", async () => {
    const without = scripted([() => reply("Done.")]);
    await runAgent({ ...base, provider: without });
    expect(without.requests[0]?.tools?.map((t) => t.name)).not.toContain("read_skill");

    const called: string[] = [];
    const withSkills = scripted([
      () => reply(null, [{ id: "c1", name: "read_skill", args: { name: "office-layout" } }]),
      () => reply("Read it."),
    ]);
    const run = await runAgent({
      ...base,
      provider: withSkills,
      skills: loadSkills([skillDirs().a]),
      callTool: async (name) => {
        called.push(name);
        return { ok: true, result: {}, warnings: [] };
      },
    });
    expect(withSkills.requests[0]?.tools?.map((t) => t.name)).toContain("read_skill");
    expect(called).toEqual([]);
    const answered = run.events.find((e) => e.type === "tool.finished") as Extract<
      AgentEvent,
      { type: "tool.finished" }
    >;
    expect((answered.result as { result: { text: string } }).result.text).toContain("Benches of six");
  });
});

describe("notes (ADR-027 D2)", () => {
  it("are a page, and no more", () => {
    expect(applyNotes({ text: "  the picture shows a courtyard  " })).toEqual({
      ok: true,
      text: "the picture shows a courtyard",
    });
    expect(applyNotes({ text: 12 })).toMatchObject({ ok: false });
    const long = applyNotes({ text: "x".repeat(NOTES_MAX_CHARS + 1) });
    expect(long).toMatchObject({ ok: false, hint: "keep what still matters and drop the rest" });
  });

  it("ride on the system prompt from the next step on, and come back with the run", async () => {
    const provider = scripted([
      () => reply(null, [{ id: "c1", name: "notes", args: { text: "the picture shows a courtyard" } }]),
      () => reply("Done."),
    ]);
    const run = await runAgent({ ...base, provider, loop: { notes: "from last time" } });
    expect(provider.requests[0]?.system).toContain("Your notes, as you wrote them:\nfrom last time");
    expect(provider.requests[1]?.system).toContain(
      "Your notes, as you wrote them:\nthe picture shows a courtyard",
    );
    expect(provider.requests[1]?.system).not.toContain("from last time");
    expect(run.notes).toBe("the picture shows a courtyard");
    expect(run.events.filter((e) => e.type === "notes.updated")).toHaveLength(1);
    // always offered: a model can write down what it learned in any session
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toContain("notes");
  });
});

describe("a plan from an earlier run (ADR-027 D5)", () => {
  const inherited = [{ id: "a", text: "furnish the office with 100 desks", status: "doing" as const }];

  it("is shown but not enforced: the gate stays quiet until this run writes a plan", async () => {
    const provider = scripted([() => reply("That is a logo, not a floor plan.")]);
    const run = await runAgent({ ...base, provider, loop: { plan: inherited }, gates: { idle: false } });
    expect(run.reason).toBe("done");
    expect(run.steps).toBe(1);
    expect(run.events.some((e) => e.type === "reminder")).toBe(false);
    // still shown, so a follow-up in the same conversation can pick it up
    expect(provider.requests[0]?.system).toContain("furnish the office with 100 desks");
    expect(run.plan).toEqual(inherited);
  });

  it("may be dropped by plan_work without a word, and the gate then holds the model to its own list", async () => {
    const provider = scripted([
      () =>
        reply(null, [
          {
            id: "c1",
            name: "plan_work",
            args: { items: [{ id: "x", text: "look at the picture", status: "doing" }] },
          },
        ]),
      () => reply("Done."),
      () => reply("Done."),
      () => reply("Done."),
    ]);
    const run = await runAgent({ ...base, provider, loop: { plan: inherited } });
    const refused = run.events.filter((e) => e.type === "tool.finished" && !e.ok);
    expect(refused).toHaveLength(0);
    expect(run.plan.map((i) => i.id)).toEqual(["x"]);
    const reminders = run.events.filter((e) => e.type === "reminder") as Extract<
      AgentEvent,
      { type: "reminder" }
    >[];
    expect(reminders[0]?.gate).toBe("plan");
    expect(reminders[0]?.text).toContain("look at the picture");
  });

  it("is handed on by a stopped run with nothing left 'doing'", async () => {
    const controller = new AbortController();
    const provider = scripted([
      () =>
        reply(null, [
          { id: "c1", name: "plan_work", args: { items: [{ id: "a", text: "walls", status: "doing" }] } },
        ]),
      () => {
        controller.abort();
        return reply("Stopping.");
      },
    ]);
    const run = await runAgent({ ...base, provider, signal: controller.signal });
    expect(run.reason).toBe("aborted");
    expect(run.plan).toEqual([{ id: "a", text: "walls", status: "pending" }]);
  });
});

describe("a picture on demand (ADR-027 D3)", () => {
  it("is put in front of a model that can see, in the tool's own words and with its own type", async () => {
    const provider = scripted(
      [
        () =>
          reply(null, [{ id: "c1", name: "look_at", args: { attachmentId: "a1", question: "what is it?" } }]),
        () => reply("A logo."),
      ],
      { vision: true },
    );
    await runAgent({
      ...base,
      provider,
      callTool: async () => ({
        ok: true,
        result: {
          caption: "as.png, which you asked to look at: what is it?",
          images: [{ name: "as.png", mime: "image/jpeg", pngBase64: "AAAA" }],
        },
        warnings: [],
      }),
    });
    const lifted = provider.requests[1]?.messages.at(-1);
    expect(lifted?.role).toBe("user");
    const parts = lifted?.content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts[0]?.text).toContain("as.png, which you asked to look at: what is it?");
    expect(parts[0]?.text).toContain("write what it shows into notes");
    expect(parts[1]?.image_url?.url).toBe("data:image/jpeg;base64,AAAA");
  });
});

describe("a reply the server could not read (run 4)", () => {
  const broken = () =>
    new ProviderError(
      "env-agent",
      200,
      'llama-server returned invalid tool call arguments for "plan_work": unexpected end of JSON input',
    );

  it("tells the model and carries on, rather than ending the run", async () => {
    let i = 0;
    const requests: CompletionRequest[] = [];
    const provider: Provider = {
      id: "fake",
      model: "fake-1",
      profile: { ...DEFAULT_PROFILE },
      async complete(req) {
        requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) as ChatMessage[] });
        i += 1;
        if (i === 1) throw broken();
        return reply("Done.");
      },
    };
    const run = await runAgent({ ...base, provider, gates: { idle: false } });
    expect(run.reason).toBe("done");
    const warned = run.events.filter((e) => e.type === "warning") as Extract<
      AgentEvent,
      { type: "warning" }
    >[];
    expect(warned[0]?.message).toContain("could not be read");
    const nudge = requests[1]?.messages.at(-1);
    expect(nudge?.role).toBe("user");
    expect(String(nudge?.content)).toContain("unexpected end of JSON input");
    expect(String(nudge?.content)).toContain("Send it again, whole");
  });

  it("treats the same failure as unreadable when it comes back as an HTTP 500", async () => {
    let i = 0;
    const provider: Provider = {
      id: "fake",
      model: "fake-1",
      profile: { ...DEFAULT_PROFILE },
      async complete() {
        i += 1;
        if (i === 1)
          throw new ProviderError(
            "env-agent",
            500,
            'HTTP 500: {"error":"llama-server returned invalid tool call arguments for \\"plan_work\\": unexpected end of JSON input"}',
          );
        return reply("Done.");
      },
    };
    const run = await runAgent({ ...base, provider, gates: { idle: false }, retryDelayMs: 0 });
    expect(run.reason).toBe("done");
    expect(run.events.some((e) => e.type === "warning" && e.message.includes("could not be read"))).toBe(
      true,
    );
    expect(run.events.some((e) => e.type === "retry")).toBe(false);
  });

  it("but not for ever", async () => {
    const provider: Provider = {
      id: "fake",
      model: "fake-1",
      profile: { ...DEFAULT_PROFILE },
      async complete() {
        throw broken();
      },
    };
    const run = await runAgent({ ...base, provider });
    expect(run.reason).toBe("provider-error");
    expect(run.events.filter((e) => e.type === "warning")).toHaveLength(UNREADABLE_REPLIES);
  });
});

describe("the same call is the same content", () => {
  it("ends a run on three identical failing designs however their keys are ordered", async () => {
    const designs = [
      '{"design":{"shell":{"w":1,"d":1},"rooms":[]}}',
      '{"design":{"rooms":[],"shell":{"d":1,"w":1}}}',
      '{"design":{"shell":{"d":1,"w":1},"rooms":[]}}',
      '{"design":{"rooms":[],"shell":{"w":1,"d":1}}}',
    ];
    let i = 0;
    const provider: Provider = {
      id: "fake",
      model: "fake-1",
      profile: { ...DEFAULT_PROFILE },
      async complete() {
        const args = designs[Math.min(i, designs.length - 1)] as string;
        i += 1;
        return {
          text: null,
          toolCalls: [{ id: `c${i}`, name: "check_design", arguments: args }],
          finishReason: "tool_calls",
          usage: { promptTokens: 1, completionTokens: 1 },
          raw: null,
        };
      },
    };
    const run = await runAgent({
      ...base,
      tools: [{ name: "check_design", description: "check", parameters: { type: "object", properties: {} } }],
      provider,
      callTool: async () => ({
        ok: false,
        error: { code: "design.unbuildable", message: "no doors", entityId: null, hint: null },
        warnings: [],
      }),
    });
    expect(run.reason).toBe("stalled");
    expect(run.steps).toBe(3);
  });
});
