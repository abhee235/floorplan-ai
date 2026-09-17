import { sequentialIdGenerator } from "@fpv/ir";
import { memoryCatalog, type ToolResult, WORKFLOW_PROMPT_NAME } from "@fpv/tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer, createSession, parseArgs, readLogLevel, toCallToolResult } from "../src/index.js";

async function connect(profile: "high" | "medium" | "low" = "high") {
  const session = createSession({
    ids: sequentialIdGenerator(1),
    now: () => "2026-09-15T12:00:00.000Z",
    catalog: memoryCatalog(),
  });
  const server = createMcpServer(session, { profile });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return { session, server, client };
}

function textOf(result: { content: unknown[] }): ToolResult {
  const first = result.content[0] as { type: string; text: string };
  return JSON.parse(first.text) as ToolResult;
}

describe("MCP adapter over an in-memory transport (ADR-005 D1, D7)", () => {
  it("lists the 25 tools with descriptions and JSON schemas, plus the workflow prompt", async () => {
    const { client } = await connect();
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(25);
    const scene = tools.tools.find((t) => t.name === "get_scene");
    expect(scene?.description).toContain("summary");
    expect((scene?.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty(
      "detail",
    );
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual([WORKFLOW_PROMPT_NAME]);
    const prompt = await client.getPrompt({ name: WORKFLOW_PROMPT_NAME });
    expect(JSON.stringify(prompt.messages)).toContain("get_scene with detail summary");
  });

  it("forwards calls to the same registry and returns the envelope as text", async () => {
    const { client, session } = await connect();
    const r = await client.callTool({
      name: "create_walls",
      arguments: {
        levelId: "level_000000",
        points: [
          { x: 0, y: 0 },
          { x: 4000, y: 0 },
          { x: 4000, y: 3000 },
          { x: 0, y: 3000 },
        ],
        closed: true,
        colour: "red",
      },
    });
    const env = textOf(r as { content: unknown[] });
    expect(env.ok).toBe(true);
    expect(env.warnings).toEqual(["Unknown arguments ignored: colour"]);
    expect(session.store.project.walls).toHaveLength(4);
    expect(session.transcript.entries).toHaveLength(1);
    const bad = await client.callTool({ name: "describe_room", arguments: { roomId: "room_zzzzzz" } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad as { content: unknown[] }).ok).toBe(false);
  });

  it("advertises the low profile subset while the rest stays callable", async () => {
    const { client } = await connect("low");
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(14);
    expect(tools.tools.map((t) => t.name)).not.toContain("create_walls");
  });

  it("render results become image content blocks", () => {
    const r = toCallToolResult({
      ok: true,
      result: {
        views: [{ name: "plan", width: 2, height: 2 }],
        images: [{ name: "plan", width: 2, height: 2, pngBase64: "AAAA" }],
      },
      warnings: [],
      problems: [],
      changed: null,
    });
    expect(r.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect((r.content[0] as { text: string }).text).not.toContain("pngBase64");
  });

  it("render through a connected viewer returns image blocks; without one, a clear error", async () => {
    const { client, session } = await connect();
    const none = await client.callTool({ name: "render", arguments: { view: "overhead" } });
    expect(none.isError).toBe(true);
    expect(textOf(none as { content: unknown[] })).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    session.ctx.viewer = {
      render: async (req) => ({
        images: (req.view === "overhead"
          ? ["overhead-ne", "overhead-nw", "overhead-se", "overhead-sw"]
          : [req.view]
        ).map((name) => ({
          name,
          width: 8,
          height: 6,
          pngBase64: "iVBORw0KGgo=",
        })),
      }),
    };
    const r = await client.callTool({ name: "render", arguments: { view: "overhead", width: 64 } });
    expect(textOf(r as { content: unknown[] })).toMatchObject({ ok: true });
    expect(r.isError).toBeUndefined();
    const content = r.content as { type: string; mimeType?: string }[];
    expect(content.filter((c) => c.type === "image")).toHaveLength(4);
    expect(content[0]?.type).toBe("text");
    const env = textOf(r as { content: unknown[] });
    expect(env.ok).toBe(true);
    if (env.ok)
      expect((env.result as { views: { name: string }[] }).views.map((v) => v.name)).toEqual([
        "overhead-ne",
        "overhead-nw",
        "overhead-se",
        "overhead-sw",
      ]);
  });

  it("the cli parses its flags", () => {
    expect(
      parseArgs(["--mcp", "--project", "x.json", "--profile", "low", "--serve", "--port", "5000"]),
    ).toEqual({
      mcp: true,
      serve: true,
      port: 5000,
      project: "x.json",
      profile: "low",
      data: null,
      agent: null,
      steps: null,
      log: null,
    });
    // how much is written down, and a level only taken when it is one this understands
    expect(parseArgs(["--log", "verbose"]).log).toBe("verbose");
    expect(parseArgs(["--log", "loud"]).log).toBeNull();
    expect(readLogLevel(undefined)).toBe("info");
    expect(readLogLevel("off")).toBe("off");
    expect(readLogLevel("shout")).toBe("info");
    expect(parseArgs(["--agent", "10-seat boardroom", "--steps", "25"])).toMatchObject({
      agent: "10-seat boardroom",
      steps: 25,
    });
    expect(parseArgs([])).toEqual({
      mcp: false,
      serve: false,
      port: 4310,
      project: null,
      profile: "high",
      data: null,
      agent: null,
      steps: null,
      log: null,
    });
  });
});
