// Scores every layout brief against the packer and writes the table (ADR-022 D2, amended).
//
// Usage:
//   corepack pnpm exec tsx tools/score-layouts.ts            print the table
//   corepack pnpm exec tsx tools/score-layouts.ts --write    and record it in docs/eval
//   corepack pnpm exec tsx tools/score-layouts.ts --brief office-100 --rooms
//
// This exists because an argument about whether a plan is any good is not settlable and a number
// is. Nothing here refuses anything; it measures, so that the next layout algorithm can be
// compared with this one on the same six briefs rather than on whichever screenshot is to hand.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CORE_RULES, checkLayout, layoutQuality, packProgramme } from "@fpv/catalog";
import { Design } from "@fpv/ir";
import { askedAdjacency, LAYOUT_BRIEFS } from "./eval/layouts.js";

const TABLE = fileURLToPath(new URL("../docs/eval/layout-quality.md", import.meta.url));

const arg = (flag: string) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const pct = (n: number) => `${Math.round(n * 100)}%`;

function main() {
  const only = arg("--brief");
  const briefs = only ? LAYOUT_BRIEFS.filter((b) => b.id === only) : LAYOUT_BRIEFS;
  if (briefs.length === 0) {
    console.error(`no brief called ${only}; try ${LAYOUT_BRIEFS.map((b) => b.id).join(", ")}`);
    process.exit(2);
  }

  const rows: string[] = [];
  for (const brief of briefs) {
    const { design: input, unplaced } = packProgramme(brief.programme);
    const design = Design.parse(input);
    const q = layoutQuality(design, { nextTo: askedAdjacency(brief.programme) });
    const report = checkLayout(design, CORE_RULES);
    const errors = report.problems.filter((p) => p.severity === "error").length;
    const shell = `${(design.shell.w / 1000).toFixed(1)}x${(design.shell.d / 1000).toFixed(1)}`;

    console.log(`\n${brief.id}  (${brief.hard})`);
    console.log(
      `  quality ${q.score.toFixed(2)}   proportion ${pct(q.proportion)}   daylight ${pct(q.daylight)}   circulation ${pct(q.circulation)}   adjacency ${pct(q.adjacency)}`,
    );
    console.log(`  shell ${shell} m   ${q.rooms} rooms   ${errors} checker errors`);
    if (q.missing.length > 0) console.log(`  missing: ${q.missing.join(", ")}`);
    if (unplaced.length > 0) console.log(`  unplaced: ${unplaced.map((u) => u.key).join(", ")}`);
    if (q.slivers.length > 0)
      console.log(
        `  ${q.slivers.length} slivers, worst ${q.slivers[0]?.name} at ${q.slivers[0]?.ratio.toFixed(1)}:1`,
      );
    if (process.argv.includes("--rooms"))
      for (const r of design.rooms)
        console.log(
          `     ${r.name.slice(0, 22).padEnd(24)}${(r.rect.w / 1000).toFixed(1).padStart(6)} x ${(r.rect.d / 1000).toFixed(1).padStart(5)} m`,
        );

    rows.push(
      `| ${brief.id} | ${q.score.toFixed(2)} | ${pct(q.proportion)} | ${pct(q.daylight)} | ${pct(q.circulation)} | ${pct(q.adjacency)} | ${q.slivers.length} | ${errors} | ${shell} |`,
    );
  }

  const mean = (pick: (b: (typeof LAYOUT_BRIEFS)[number]) => number) =>
    briefs.reduce((n, b) => n + pick(b), 0) / briefs.length;
  console.log(
    `\nmean quality across ${briefs.length} briefs: ${mean((b) => {
      const design = Design.parse(packProgramme(b.programme).design);
      return layoutQuality(design, { nextTo: askedAdjacency(b.programme) }).score;
    }).toFixed(3)}`,
  );

  if (process.argv.includes("--write")) {
    const body = [
      "# Layout quality",
      "",
      "What `tools/score-layouts.ts` measures, per brief. Correctness is the checker's column and is",
      "mostly zero; the rest is whether anybody would want to be in the building. Proportion is the",
      "share of rooms no longer than two and a half times their own width, and it is the column that",
      "the current packer fails.",
      "",
      `Recorded ${new Date().toISOString().slice(0, 10)}, packer at the strip layout.`,
      "",
      "| brief | quality | proportion | daylight | circulation | adjacency | slivers | checker errors | shell m |",
      "|---|---|---|---|---|---|---|---|---|",
      ...rows,
      "",
    ].join("\n");
    writeFileSync(TABLE, body, "utf8");
    console.log(`\nwritten to ${TABLE}`);
  }
}

main();
