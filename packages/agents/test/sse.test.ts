// Reading an event stream: the parts that go wrong quietly.
//
// Every case here is a real shape a server sends. A frame split across two network chunks is the one
// that matters most: a parser without a tail buffer passes every hand-written test and then drops
// half a tool call the first time the network is slow.
import { describe, expect, it } from "vitest";
import { DONE, decodeChunk, sseData, sseReader } from "../src/sse.js";

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const bytes = (s: string) => new TextEncoder().encode(s);

async function collect(chunks: string[]): Promise<unknown[]> {
  async function* body() {
    for (const c of chunks) yield bytes(c);
  }
  const out: unknown[] = [];
  for await (const data of sseData(body())) out.push(JSON.parse(data));
  return out;
}

describe("the framing", () => {
  it("reads one payload per event", () => {
    const r = sseReader();
    expect(r.push('data: {"a":1}\n\ndata: {"a":2}\n\n')).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("holds a frame that arrives in pieces, however it is cut", () => {
    const r = sseReader();
    expect(r.push('data: {"he')).toEqual([]);
    expect(r.push('llo":"wo')).toEqual([]);
    expect(r.push('rld"}\n')).toEqual([]); // the event is not over until the blank line
    expect(r.push("\n")).toEqual(['{"hello":"world"}']);
  });

  it("reads lines that end with CRLF", () => {
    const r = sseReader();
    expect(r.push('data: {"a":1}\r\n\r\n')).toEqual(['{"a":1}']);
  });

  it("joins the several data lines of one event, as the format says", () => {
    const r = sseReader();
    expect(r.push("data: one\ndata: two\n\n")).toEqual(["one\ntwo"]);
  });

  it("drops keep-alive comments and fields it has no use for", () => {
    const r = sseReader();
    expect(r.push(": ping\n\nevent: message\nid: 7\ndata: kept\n\n")).toEqual(["kept"]);
  });

  it("gives up its last event when a stream stops without a blank line", () => {
    const r = sseReader();
    expect(r.push("data: last")).toEqual([]);
    expect(r.end()).toEqual(["last"]);
  });

  it("stops at the end marker and yields nothing after it", async () => {
    const got = await collect([frame({ a: 1 }), `data: ${DONE}\n\n`, frame({ a: 2 })]);
    expect(got).toEqual([{ a: 1 }]);
  });

  it("reads a body that hands over bytes split mid-character", async () => {
    // "°" is two bytes in UTF-8; a decoder without streaming turns half of it into a replacement
    const whole = bytes(frame({ text: "45°" }));
    const got = await collect([
      new TextDecoder().decode(whole.subarray(0, 20), { stream: true }),
      new TextDecoder().decode(whole.subarray(20)),
    ]);
    expect((got[0] as { text: string }).text).toBe("45°");
  });
});

describe("the deltas", () => {
  it("reads text and the reasoning a server chooses to show", () => {
    expect(decodeChunk({ choices: [{ delta: { content: "Hel" } }] }, 0)).toEqual([
      { type: "text", delta: "Hel" },
    ]);
    // one server calls it reasoning, another reasoning_content; both are the same thing
    expect(decodeChunk({ choices: [{ delta: { reasoning: "hmm" } }] }, 0)).toEqual([
      { type: "reasoning", delta: "hmm" },
    ]);
    expect(decodeChunk({ choices: [{ delta: { reasoning_content: "hmm" } }] }, 0)).toEqual([
      { type: "reasoning", delta: "hmm" },
    ]);
  });

  it("keeps two tool calls apart by their index, whichever order their pieces arrive in", () => {
    const first = decodeChunk(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "create_walls", arguments: "" } },
                { index: 1, id: "c2", function: { name: "validate", arguments: "" } },
              ],
            },
          },
        ],
      },
      0,
    );
    expect(first).toMatchObject([
      { type: "tool_call", index: 0, id: "c1", name: "create_walls" },
      { type: "tool_call", index: 1, id: "c2", name: "validate" },
    ]);
    const more = decodeChunk(
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"a":' } }] } }] },
      2,
    );
    expect(more).toEqual([{ type: "tool_call", index: 1, argumentsDelta: '{"a":' }]);
  });

  it("guesses an index only when a server sends none: a name starts a call, anything else continues it", () => {
    const start = decodeChunk(
      { choices: [{ delta: { tool_calls: [{ id: "c1", function: { name: "validate" } }] } }] },
      0,
    );
    expect(start[0]).toMatchObject({ index: 0, name: "validate" });
    const cont = decodeChunk(
      { choices: [{ delta: { tool_calls: [{ function: { arguments: "{}" } }] } }] },
      1,
    );
    expect(cont[0]).toMatchObject({ index: 0, argumentsDelta: "{}" });
  });

  it("reads the finish, and the usage that rides on a chunk of its own", () => {
    expect(decodeChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }, 0)).toEqual([
      { type: "finish", finishReason: "tool_calls", usage: null },
    ]);
    expect(decodeChunk({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }, 0)).toEqual([
      { type: "finish", finishReason: null, usage: { promptTokens: 12, completionTokens: 3 } },
    ]);
  });

  it("says nothing about an empty delta, which is how a stream opens", () => {
    expect(decodeChunk({ choices: [{ delta: { role: "assistant" } }] }, 0)).toEqual([]);
  });
});
