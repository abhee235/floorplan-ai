// Extracts one page of a real PDF into a fixture the tests can use offline (spec 06 A6). The reports these
// pages come from are tens of megabytes, so the fixture keeps just that page's painted line work and text
// runs, rounded to 0.01 pt. Their licences live in tools/fixtures/plans-pdf-real/SOURCES.md.
//
// Usage: corepack pnpm exec tsx tools/build-pdf-real-fixture.ts <file.pdf> <page> <name>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PdfPageContent } from "@fpv/importers";
import { extractPdfPages } from "../apps/host/src/pdf.js";

const OUT = fileURLToPath(new URL("./fixtures/plans-pdf-real/", import.meta.url));

const [file, pageArg, name] = process.argv.slice(2);
if (!file || !pageArg || !name) {
  console.error("usage: tsx tools/build-pdf-real-fixture.ts <file.pdf> <page> <name>");
  process.exit(2);
}
const page = Number(pageArg);
const r2 = (n: number) => Math.round(n * 100) / 100;
const pt = (p: { x: number; y: number }) => ({ x: r2(p.x), y: r2(p.y) });

const [content] = await extractPdfPages(new Uint8Array(readFileSync(file)), page);
if (!content) throw new Error(`${file} has no page ${page}`);
const rounded: PdfPageContent = {
  page: content.page,
  width: r2(content.width),
  height: r2(content.height),
  images: content.images,
  paths: content.paths.map((path) => ({
    ...path,
    lineWidth: r2(path.lineWidth),
    subpaths: path.subpaths.map((s) => ({
      start: pt(s.start),
      closed: s.closed,
      commands: s.commands.map((c) =>
        c.op === "L" ? { op: c.op, to: pt(c.to) } : { op: c.op, c1: pt(c.c1), c2: pt(c.c2), to: pt(c.to) },
      ),
    })),
  })),
  texts: content.texts.map((t) => ({
    str: t.str,
    x: r2(t.x),
    y: r2(t.y),
    height: r2(t.height),
    rotation: r2(t.rotation),
    width: r2(t.width),
  })),
};
mkdirSync(OUT, { recursive: true });
const out = `${OUT}${name}.page.json`;
writeFileSync(out, `${JSON.stringify(rounded)}\n`);
const segments = rounded.paths.reduce((n, p) => n + p.subpaths.reduce((m, s) => m + s.commands.length, 0), 0);
console.log(
  `${out}: page ${page}, ${rounded.paths.length} paths, ${segments} segments, ${rounded.texts.length} texts, ${Math.round(readFileSync(out).length / 1024)} KB`,
);
