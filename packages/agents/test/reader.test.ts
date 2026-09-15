import { describe, expect, it } from "vitest";
import { openAICompatible, planReader, ReaderUnavailableError } from "../src/index.js";

function fakeFetch(replies: string[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const content = replies[Math.min(bodies.length - 1, replies.length - 1)] as string;
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content } }],
        usage: { prompt_tokens: 1200, completion_tokens: 300 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetch, bodies };
}

const IMAGE = {
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  info: { format: "png" as const, width: 2000, height: 1000, mime: "image/png" },
  fileName: "plan.png",
};

const GOOD = JSON.stringify({
  walls: [
    { from: [100, 100], to: [900, 100], thickness: 10, exterior: true },
    { from: [900, 100], to: [900, 450], thickness: 10, exterior: true },
  ],
  openings: [{ kind: "door", at: [500, 100], width: 40 }],
  rooms: [{ name: "HUDDLE", at: [500, 300] }],
  dimensions: [],
  notes: [],
});

describe("plan reader role (ADR-011 D4)", () => {
  it("sends the image with the reader-v1 prompt and returns a cleaned draft with the reader recorded", async () => {
    const { fetch, bodies } = fakeFetch([GOOD]);
    const provider = openAICompatible(
      { id: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen-vl", profile: { vision: true } },
      fetch,
    );
    const reading = await planReader(provider).read(IMAGE);
    const messages = bodies[0]?.messages as { role: string; content: unknown }[];
    expect(messages[0]?.role).toBe("system");
    expect(String(messages[0]?.content)).toContain("run from 0 to 1000 across the image");
    const parts = messages[1]?.content as { type: string; image_url?: { url: string }; text?: string }[];
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url"]);
    expect(parts[1]?.image_url?.url).toBe(IMAGE.dataUrl);
    expect(parts[0]?.text).toContain("0 to 1000 on each axis");
    expect(reading.draft.reader).toEqual({
      providerId: "local",
      model: "qwen-vl",
      promptVersion: "reader-v1",
    });
    expect(reading.draft.walls).toHaveLength(2);
    expect(reading.draft.openings[0]?.wallIdx).not.toBeNull();
    expect(reading.draft.questions.some((q) => q.kind === "scale")).toBe(true);
  });

  it("retries with the validation error when the first reply is not usable", async () => {
    const { fetch, bodies } = fakeFetch(['{"walls": [{"from": [1]}]}', GOOD]);
    const provider = openAICompatible(
      { id: "p", baseUrl: "http://x/v1", model: "m", profile: { vision: true } },
      fetch,
    );
    const reading = await planReader(provider).read(IMAGE);
    expect(reading.attempts).toBe(2);
    const retry = (bodies[1]?.messages as { role: string; content: unknown }[]).at(-1);
    expect(String(retry?.content)).toContain("cannot be used");
  });

  it("refuses a model that is not marked as able to read images", async () => {
    const { fetch } = fakeFetch([GOOD]);
    const provider = openAICompatible({ id: "p", baseUrl: "http://x/v1", model: "text-only" }, fetch);
    await expect(planReader(provider).read(IMAGE)).rejects.toBeInstanceOf(ReaderUnavailableError);
  });
});
