// Builds tools/fixtures/plans-raster: plan images for the raster reader (ADR-011 D6, PRD P2-2). Each generated
// DXF plan is drawn the way a scanned or exported plan image looks (black wall lines, door swings, window
// lines, room names, dimension strings) as an SVG, and its expected walls and openings are moved into the
// reader's box frame: the image's longer side is 1000 units, y up from the bottom-left corner. The PNG next to
// each SVG is a screenshot of that SVG at its own pixel size; regenerate it the same way after changing this.
// Usage: corepack pnpm exec tsx tools/build-raster-fixtures.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ExpectedPlan, flatten, imageBox, layerRole, parseDxf } from "@fpv/importers";

const PLANS = fileURLToPath(new URL("./fixtures/plans/", import.meta.url));
const OUT = fileURLToPath(new URL("./fixtures/plans-raster/", import.meta.url));
/** Pixels on the longer side of every image. */
const LONG_SIDE_PX = 1600;
/** Margin around the drawing in millimetres. */
const MARGIN_MM = 1500;

function build(name: string) {
  const text = readFileSync(`${PLANS}${name}.dxf`, "utf8");
  const expected = JSON.parse(readFileSync(`${PLANS}${name}.expected.json`, "utf8")) as ExpectedPlan;
  const unit = expected.mmPerUnit;
  const doc = parseDxf(text);
  const hidden = new Set([...doc.layers.values()].filter((l) => l.frozen || l.off).map((l) => l.name));
  const placed = flatten(doc).placed.filter((p) => !hidden.has(p.entity.layer));
  // extent in millimetres from the drawing's own geometry, plus a margin
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x * unit);
    minY = Math.min(minY, y * unit);
    maxX = Math.max(maxX, x * unit);
    maxY = Math.max(maxY, y * unit);
  };
  for (const { entity: e } of placed) {
    if (e.type === "LINE") {
      grow(e.a.x, e.a.y);
      grow(e.b.x, e.b.y);
    } else if (e.type === "POLYLINE") for (const v of e.vertices) grow(v.x, v.y);
  }
  minX -= MARGIN_MM;
  minY -= MARGIN_MM;
  maxX += MARGIN_MM;
  maxY += MARGIN_MM;
  const pxPerMm = LONG_SIDE_PX / Math.max(maxX - minX, maxY - minY);
  const W = Math.round((maxX - minX) * pxPerMm);
  const H = Math.round((maxY - minY) * pxPerMm);
  const sx = (x: number) => ((x * unit - minX) * pxPerMm).toFixed(2);
  const sy = (y: number) => ((maxY - y * unit) * pxPerMm).toFixed(2);
  const parts: string[] = [];
  const stroke = (role: string) =>
    role === "wall"
      ? 'stroke="#111" stroke-width="2.2"'
      : role === "dimension"
        ? 'stroke="#555" stroke-width="0.8"'
        : 'stroke="#222" stroke-width="1.2"';
  for (const { entity: e } of placed) {
    const role = layerRole(e.layer);
    if (role === "furniture" || role === "ignore") continue;
    if (e.type === "LINE")
      parts.push(
        `<line x1="${sx(e.a.x)}" y1="${sy(e.a.y)}" x2="${sx(e.b.x)}" y2="${sy(e.b.y)}" ${stroke(role)}/>`,
      );
    else if (e.type === "POLYLINE") {
      if (role === "room") continue;
      const pts = e.vertices.map((v) => `${sx(v.x)},${sy(v.y)}`).join(" ");
      parts.push(`<${e.closed ? "polygon" : "polyline"} points="${pts}" fill="none" ${stroke(role)}/>`);
    } else if (e.type === "ARC") {
      const a0 = (e.start * Math.PI) / 180;
      const a1 = (e.end * Math.PI) / 180;
      let sweep = e.end - e.start;
      if (sweep <= 0) sweep += 360;
      const x0 = e.centre.x + e.radius * Math.cos(a0);
      const y0 = e.centre.y + e.radius * Math.sin(a0);
      const x1 = e.centre.x + e.radius * Math.cos(a1);
      const y1 = e.centre.y + e.radius * Math.sin(a1);
      const r = (e.radius * unit * pxPerMm).toFixed(2);
      parts.push(
        `<path d="M ${sx(x0)} ${sy(y0)} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 0 ${sx(x1)} ${sy(y1)}" fill="none" ${stroke(role)}/>`,
      );
    } else if (e.type === "TEXT" && e.text) {
      const size = Math.max(11, e.height * unit * pxPerMm * 1.1).toFixed(1);
      for (const [i, line] of e.text.split("\n").entries())
        parts.push(
          `<text x="${sx(e.at.x)}" y="${(Number(sy(e.at.y)) + i * Number(size) * 1.2).toFixed(2)}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" text-anchor="middle" fill="#111">${line.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`,
        );
    } else if (e.type === "DIMENSION") {
      const a = { x: sx(e.p1.x), y: sy(e.p1.y) };
      const b = { x: sx(e.p2.x), y: sy(e.p2.y) };
      const offset = 28;
      const horizontal = Math.abs(Number(a.y) - Number(b.y)) < Math.abs(Number(a.x) - Number(b.x));
      const [lx1, ly1, lx2, ly2] = horizontal
        ? [a.x, Number(a.y) + offset, b.x, Number(b.y) + offset]
        : [Number(a.x) - offset, a.y, Number(b.x) - offset, b.y];
      const label =
        e.text && !e.text.includes("<>")
          ? e.text
          : e.measurement !== null
            ? String(Math.round(e.measurement * unit))
            : "";
      if (!label) continue;
      parts.push(`<line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="#555" stroke-width="0.8"/>`);
      const mx = (Number(lx1) + Number(lx2)) / 2;
      const my = (Number(ly1) + Number(ly2)) / 2;
      parts.push(
        horizontal
          ? `<text x="${mx.toFixed(2)}" y="${(my - 5).toFixed(2)}" font-family="Arial, Helvetica, sans-serif" font-size="13" text-anchor="middle" fill="#333">${label}</text>`
          : `<text x="${(mx - 5).toFixed(2)}" y="${my.toFixed(2)}" font-family="Arial, Helvetica, sans-serif" font-size="13" text-anchor="middle" fill="#333" transform="rotate(-90 ${(mx - 5).toFixed(2)} ${my.toFixed(2)})">${label}</text>`,
      );
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/>${parts.join("")}</svg>\n`;

  // expected geometry in the reader's frame: box units, y up from the bottom-left of the image
  const box = imageBox(W, H);
  const mmPerBoxUnit = 1 / (pxPerMm * box.unitsPerPixel);
  const toFrame = (p: { x: number; y: number }) => ({
    x: Math.round((p.x - minX) * 10) / 10,
    y: Math.round((p.y - minY) * 10) / 10,
  });
  const framed: ExpectedPlan & { image: { file: string; width: number; height: number }; source: string } = {
    name: `${name}-raster`,
    source: `tools/fixtures/plans/${name}.dxf drawn by tools/build-raster-fixtures.ts`,
    image: { file: `${name}.png`, width: W, height: H },
    mmPerUnit: Math.round(mmPerBoxUnit * 1e6) / 1e6,
    walls: expected.walls.map((w) => ({ points: w.points.map(toFrame), thickness: w.thickness })),
    openings: expected.openings.map((o) => ({ ...o, at: toFrame(o.at) })),
    rooms: expected.rooms.map((r) => ({ name: r.name, areaM2: r.areaM2 })),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}${name}.svg`, svg);
  writeFileSync(`${OUT}${name}.expected.json`, `${JSON.stringify(framed, null, 2)}\n`);
  console.log(`${name}: ${W}x${H} px, ${parts.length} shapes, ${framed.mmPerUnit} mm per box unit`);
}

for (const name of ["office-mm", "lshape-metres"]) build(name);
