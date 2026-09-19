// PRD P1-7 and P1-8 without a model: scripted providers drive the real registry through the host's agent task
// runner on both task cards, the transcript is written as JSONL, and the cards score as passes. A scripted run
// that stops early scores as a failure with what is missing.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Completion, CompletionRequest, Provider, ToolCall } from "@fpv/agents";
import { describe, expect, it } from "vitest";
import { runAgentTask } from "../../apps/host/src/agent.js";
import { loadCards, mergeRunsSection, renderRunsTable, scoreCard } from "../eval/cards.js";
import { evalSession } from "../eval/session.js";

const NOW = "2026-09-16T12:00:00.000Z";

function scripted(steps: ((req: CompletionRequest) => ToolCall[] | string)[]): Provider {
  let i = 0;
  return {
    id: "scripted",
    model: "scripted-1",
    profile: {
      vision: false,
      toolCalls: true,
      toolReliability: "low",
      contextTokens: 32000,
      jsonMode: false,
    },
    async complete(req): Promise<Completion> {
      const step = steps[Math.min(i, steps.length - 1)] as (r: CompletionRequest) => ToolCall[] | string;
      i += 1;
      const out = step(req);
      return {
        text: typeof out === "string" ? out : null,
        toolCalls: typeof out === "string" ? [] : out,
        finishReason: null,
        usage: { promptTokens: 100, completionTokens: 20 },
        raw: null,
      };
    },
  };
}

const call = (name: string, args: unknown): ToolCall => ({
  id: `c_${name}`,
  name,
  arguments: JSON.stringify(args),
});

/** The result of the latest tool message in a request. */
const lastResult = (req: CompletionRequest) => {
  const msg = [...req.messages].reverse().find((m) => m.role === "tool");
  return JSON.parse(String(msg?.content ?? "{}")) as { result?: Record<string, unknown> };
};

describe("agent evaluation harness (PRD P1-7, P1-8)", () => {
  const cards = loadCards();

  it("the boardroom card passes when the model builds and furnishes the room from the brief", async () => {
    const card = cards.find((c) => c.id === "boardroom");
    if (!card) throw new Error("no boardroom card");
    const { session, close } = evalSession(() => NOW);
    const dir = mkdtempSync(join(tmpdir(), "fpv-eval-"));
    try {
      const provider = scripted([
        () => [call("get_scene", { detail: "summary" })],
        () => [
          call("create_room_from_brief", { brief: "10-seat boardroom, 8 by 5 metres, video conferencing" }),
        ],
        () => [call("validate", {})],
        () => [call("get_bom", { scope: "project" })],
        () => "Built and furnished the boardroom; no validation errors.",
      ]);
      const { run, transcriptPath } = await runAgentTask(session, provider, card.task, {
        transcriptDir: dir,
        maxSteps: card.maxSteps,
        now: () => NOW,
      });
      const score = scoreCard(card, session, run, {
        model: provider.model,
        provider: provider.id,
        reliability: "low",
        at: NOW,
        seconds: 1,
        transcript: transcriptPath,
      });
      expect(score.missing).toEqual([]);
      expect(score).toMatchObject({
        pass: true,
        reason: "done",
        steps: 5,
        toolCalls: 4,
        failedCalls: 0,
        validationErrors: 0,
      });
      expect(score.bomLines).toBeGreaterThan(0);
      const lines = readFileSync(transcriptPath as string, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines[0]).toMatchObject({
        type: "start",
        model: "scripted-1",
        reliability: "low",
        task: card.task,
      });
      expect(lines[0].tools).toContain("create_room_from_brief");
      expect(lines.at(-1)).toMatchObject({ type: "done", reason: "done", steps: 5 });
      expect(lines.filter((l) => l.type === "tool.finished").map((l) => l.name)).toEqual([
        "get_scene",
        "create_room_from_brief",
        "validate",
        "get_bom",
      ]);
      const table = renderRunsTable([score, { ...score, at: "2026-09-15T00:00:00.000Z", pass: false }]);
      expect(table.split("\n")).toHaveLength(3);
      expect(table).toContain("| boardroom | scripted-1 | low | pass | 5 of 40 |");
      const md = mergeRunsSection("# Title\n\nNotes.\n", table);
      expect(mergeRunsSection(md, "| new |")).toBe(
        "# Title\n\nNotes.\n\n<!-- runs:start -->\n| new |\n<!-- runs:end -->\n",
      );
    } finally {
      close();
    }
  });

  it("the import card passes when the model imports and confirms the DXF", async () => {
    const card = cards.find((c) => c.id === "import-office");
    if (!card) throw new Error("no import card");
    const { session, close } = evalSession(() => NOW);
    try {
      const provider = scripted([
        () => [call("import_plan", { path: "tools/fixtures/plans/office-mm.dxf" })],
        (req) => [call("import_plan", { draftId: lastResult(req).result?.draftId, confirm: true })],
        () => "Imported three rooms: BOARDROOM, OPEN OFFICE and MEETING ROOM.",
      ]);
      const { run } = await runAgentTask(session, provider, card.task, {
        maxSteps: card.maxSteps,
        now: () => NOW,
      });
      const score = scoreCard(card, session, run, {
        model: "scripted-1",
        provider: "scripted",
        reliability: "low",
        at: NOW,
        seconds: 1,
        transcript: null,
      });
      expect(score.missing).toEqual([]);
      expect(score).toMatchObject({ pass: true, steps: 3, failedCalls: 0 });
    } finally {
      close();
    }
  });

  it("a run that stops early fails and says what is missing", async () => {
    const card = cards.find((c) => c.id === "boardroom");
    if (!card) throw new Error("no boardroom card");
    const { session, close } = evalSession(() => NOW);
    try {
      const provider = scripted([
        () => [call("get_scene", { detail: "summary" })],
        () => "I looked at the scene.",
      ]);
      const { run } = await runAgentTask(session, provider, card.task, {
        maxSteps: card.maxSteps,
        now: () => NOW,
      });
      const score = scoreCard(card, session, run, {
        model: "scripted-1",
        provider: "scripted",
        reliability: "low",
        at: NOW,
        seconds: 1,
        transcript: null,
      });
      expect(score.pass).toBe(false);
      expect(score.missing).toContain("room boardroom 10+ seats 36-44 m2");
      expect(score.missing).toContain("scheduler");
    } finally {
      close();
    }
  });
});
