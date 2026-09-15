// Scores a vision reader on the raster fixtures (PRD P2-2, spec 06 A4). Each PNG in tools/fixtures/plans-raster
// is read by the configured model, the scale is confirmed from the fixture (as a person would in the review),
// and wall and opening recall are printed. Raw replies are saved to docs/eval for comparison across models.
//
// Usage:
//   FPV_READER_BASE_URL=http://127.0.0.1:11434/v1 FPV_READER_MODEL=qwen3.6:35b \
//   FPV_READER_EXTRA_BODY='{"reasoning_effort":"none"}' corepack pnpm exec tsx tools/score-raster.ts [--only office-mm] [--no-refine]
// Replay saved replies without calling the model (to compare clean-up changes):
//   corepack pnpm exec tsx tools/score-raster.ts --replay docs/eval/raster-qwen3.6_35b.json [--no-refine]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { openAICompatible, planReader } from "@fpv/agents";
import {
  decodePngGray,
  type ExpectedPlan,
  imageInfo,
  RasterReply,
  rasterReplyToDraft,
  refineRasterDraft,
  scoreDraft,
  withScale,
} from "@fpv/importers";

import { loadDotEnv } from "../apps/host/src/env.js";

// FPV_READER_PROVIDER and FPV_READER_MODEL in .env configure the model as they do for the host
loadDotEnv();
const DIR = fileURLToPath(new URL("./fixtures/plans-raster/", import.meta.url));
const EVAL = fileURLToPath(new URL("../docs/eval/", import.meta.url));

const argValue = (flag: string) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const only = argValue("--only");
const replayFile = argValue("--replay");
const refine = !process.argv.includes("--no-refine");

interface SavedRow {
  plan: string;
  reply?: unknown;
}
const replay: Map<string, unknown> | null = replayFile
  ? new Map(
      (JSON.parse(readFileSync(replayFile, "utf8")) as { rows: SavedRow[] }).rows
        .filter((r) => r.reply !== undefined)
        .map((r) => [r.plan, r.reply]),
    )
  : null;
const savedModel = replayFile
  ? (JSON.parse(readFileSync(replayFile, "utf8")) as { model: string }).model
  : undefined;

const baseUrl = process.env.FPV_READER_BASE_URL;
const model = replay ? (savedModel ?? "replay") : process.env.FPV_READER_MODEL;
if (!replay && (!baseUrl || !model)) {
  console.error(
    "set FPV_READER_BASE_URL and FPV_READER_MODEL (and FPV_READER_API_KEY for hosted providers), or pass --replay <saved run>",
  );
  process.exit(2);
}
let extraBody: Record<string, unknown> | undefined;
if (process.env.FPV_READER_EXTRA_BODY)
  extraBody = JSON.parse(process.env.FPV_READER_EXTRA_BODY) as Record<string, unknown>;

const reader = replay
  ? null
  : planReader(
      openAICompatible({
        id: "eval-reader",
        baseUrl: baseUrl as string,
        model: model as string,
        apiKey: process.env.FPV_READER_API_KEY ?? null,
        profile: { vision: true },
        timeoutMs: Number(process.env.FPV_READER_TIMEOUT_MS) || 900_000,
        ...(extraBody ? { extraBody } : {}),
      }),
      { maxTokens: Number(process.env.FPV_READER_MAX_TOKENS) || 8_000 },
    );

const names = readdirSync(DIR)
  .filter((f) => f.endsWith(".expected.json"))
  .map((f) => f.slice(0, -".expected.json".length))
  .filter((n) => !only || n === only)
  .sort();

const rows: Record<string, unknown>[] = [];
for (const name of names) {
  const expected = JSON.parse(readFileSync(`${DIR}${name}.expected.json`, "utf8")) as ExpectedPlan & {
    image: { file: string };
  };
  const png = `${DIR}${expected.image.file}`;
  if (!existsSync(png)) {
    console.error(`${name}: ${expected.image.file} is missing; screenshot the SVG to make it`);
    continue;
  }
  const bytes = new Uint8Array(readFileSync(png));
  const info = imageInfo(bytes);
  if (!info) throw new Error(`${png} is not a readable image`);
  const bitmap = refine ? decodePngGray(bytes, (d) => new Uint8Array(inflateSync(d))) : null;
  const dataUrl = `data:${info.mime};base64,${Buffer.from(bytes).toString("base64")}`;
  const start = performance.now();
  try {
    let draft: ReturnType<typeof rasterReplyToDraft>;
    let reply: RasterReply;
    let attempts = 0;
    let usage = { promptTokens: 0, completionTokens: 0 };
    let refined: { snapped: number; dropped: number } | null = null;
    if (replay) {
      const saved = replay.get(name);
      if (saved === undefined) {
        console.error(`${name}: no saved reply in ${replayFile}`);
        continue;
      }
      reply = RasterReply.parse(saved);
      const raw = rasterReplyToDraft(reply, info, { file: expected.image.file });
      const r = bitmap ? refineRasterDraft(raw, bitmap) : null;
      draft = r ? r.draft : raw;
      refined = r ? r.report : null;
    } else {
      const reading = await (reader as NonNullable<typeof reader>).read({
        dataUrl,
        info,
        fileName: expected.image.file,
        bitmap,
      });
      draft = reading.draft;
      reply = reading.reply;
      attempts = reading.attempts;
      usage = reading.usage;
      refined = reading.refined;
    }
    const seconds = (performance.now() - start) / 1000;
    const s = scoreDraft(withScale(draft, { mmPerUnit: expected.mmPerUnit }), expected);
    const row = {
      plan: name,
      model,
      refined: refined !== null,
      snapped: refined?.snapped ?? 0,
      dropped: refined?.dropped ?? 0,
      seconds: Math.round(seconds),
      attempts,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      walls: draft.walls.length,
      openings: draft.openings.length,
      rooms: draft.rooms.map((r) => r.name),
      scaleReadAs: draft.units.scaleSource,
      wallRecall: Math.round(s.wallRecall * 1000) / 1000,
      wallPrecision: Math.round(s.wallPrecision * 1000) / 1000,
      openingRecall: Math.round(s.openingRecall * 1000) / 1000,
      roomRecall: Math.round(s.roomRecall * 1000) / 1000,
    };
    rows.push({ ...row, reply });
    console.log(JSON.stringify(row));
  } catch (e) {
    const seconds = Math.round((performance.now() - start) / 1000);
    console.log(
      JSON.stringify({ plan: name, model, seconds, error: e instanceof Error ? e.message : String(e) }),
    );
    rows.push({ plan: name, model, seconds, error: e instanceof Error ? e.message : String(e) });
  }
}
if (!replay) {
  mkdirSync(EVAL, { recursive: true });
  const file = `${EVAL}raster-${(model as string).replace(/[^a-z0-9.-]+/gi, "_")}.json`;
  writeFileSync(
    file,
    `${JSON.stringify({ at: new Date().toISOString(), baseUrl, model, refine, rows }, null, 2)}\n`,
  );
  console.log(`saved ${file}`);
}
