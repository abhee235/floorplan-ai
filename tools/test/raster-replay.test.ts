// PRD P2-2 without a model: replies recorded from local vision models (tools/fixtures/plans-raster/replies) go
// through the same conversion, clean-up and refinement against the fixture PNGs, and must reach wall recall 0.8 after
// scale confirmation (spec 06 A4). Re-record replies with tools/score-raster.ts when the reader contract changes.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { createStore } from "@fpv/commands";
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
import { sequentialIdGenerator } from "@fpv/ir";
import { blankProject, catalogSourceOf, commitDraft, memoryCatalog } from "@fpv/tools";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../fixtures/plans-raster/", import.meta.url));

interface Recorded {
  model: string;
  replies: Record<string, unknown>;
}

const recordings = readdirSync(`${DIR}replies`)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(`${DIR}replies/${f}`, "utf8")) as Recorded);

function score(plan: string, reply: unknown, refine: boolean) {
  const expected = JSON.parse(readFileSync(`${DIR}${plan}.expected.json`, "utf8")) as ExpectedPlan & {
    image: { file: string };
  };
  const bytes = new Uint8Array(readFileSync(`${DIR}${expected.image.file}`));
  const info = imageInfo(bytes);
  if (!info) throw new Error(`${expected.image.file} is not an image`);
  let draft = rasterReplyToDraft(RasterReply.parse(reply), info, { file: expected.image.file });
  if (refine)
    draft = refineRasterDraft(
      draft,
      decodePngGray(bytes, (d) => new Uint8Array(inflateSync(d))),
    ).draft;
  return scoreDraft(withScale(draft, { mmPerUnit: expected.mmPerUnit }), expected);
}

describe("raster reader on recorded model replies (PRD P2-2)", () => {
  it("replies from at least two models are recorded for both fixture images", () => {
    expect(recordings.length).toBeGreaterThanOrEqual(2);
    for (const r of recordings) expect(Object.keys(r.replies).sort()).toEqual(["lshape-metres", "office-mm"]);
  });

  for (const recording of recordings)
    for (const plan of Object.keys(recording.replies).sort())
      it(`${recording.model} on ${plan}: wall recall 0.8 after refinement, and refinement never makes it worse`, () => {
        const reply = recording.replies[plan];
        const refined = score(plan, reply, true);
        const unrefined = score(plan, reply, false);
        const detail = JSON.stringify({ refined, unrefined: unrefined.wallRecall });
        expect(refined.wallRecall, detail).toBeGreaterThanOrEqual(0.8);
        expect(refined.wallRecall + 1e-9, detail).toBeGreaterThanOrEqual(unrefined.wallRecall);
        expect(refined.roomRecall, detail).toBeGreaterThanOrEqual(0.3);
      });
});

describe("committing refined raster drafts", () => {
  for (const recording of recordings)
    for (const plan of Object.keys(recording.replies).sort())
      it(`${recording.model} on ${plan}: the committed walls enclose every labelled room`, () => {
        const expected = JSON.parse(readFileSync(`${DIR}${plan}.expected.json`, "utf8")) as ExpectedPlan & {
          image: { file: string };
        };
        const bytes = new Uint8Array(readFileSync(`${DIR}${expected.image.file}`));
        const info = imageInfo(bytes);
        if (!info) throw new Error("not an image");
        const raw = rasterReplyToDraft(RasterReply.parse(recording.replies[plan]), info, {
          file: expected.image.file,
        });
        const { draft } = refineRasterDraft(
          raw,
          decodePngGray(bytes, (d) => new Uint8Array(inflateSync(d))),
        );
        const now = "2026-09-16T12:00:00.000Z";
        const store = createStore(blankProject("raster", now), {
          ids: sequentialIdGenerator(1),
          now: () => now,
          catalog: catalogSourceOf(memoryCatalog([]), () => now),
        });
        const report = commitDraft(store, withScale(draft, { mmPerUnit: expected.mmPerUnit }), {
          levelId: "level_000000",
          label: "raster",
          now,
        });
        const names = store.project.rooms.map((r) => r.name).filter(Boolean);
        expect(names.sort(), JSON.stringify(report.skipped)).toEqual(
          expected.rooms.map((r) => r.name).sort(),
        );
      });
});
