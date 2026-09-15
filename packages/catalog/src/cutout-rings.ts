// Cut-out path to rings (ADR-014 D7 step 3; O-074, O-076): the SVG path of a door or window, in the unit
// square with y down, as closed rings with curves flattened. Every subpath becomes a ring; the engine unions
// them, so a subpath inside another fills it instead of leaving an island.
import { isValidCutOutPath } from "./cutout.js";

export interface UnitPoint {
  x: number;
  y: number;
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const MAX_SEGMENTS = 256;

/** Chord tolerance in unit-square units for an opening of the given size: 0.5 mm on its larger side (O-074). */
export function cutOutTolerance(widthMm: number, heightMm: number): number {
  return 0.5 / Math.max(widthMm, heightMm, 1);
}

function tokenize(path: string): string[] {
  return path
    .trim()
    .replace(/([MmLlHhVvZzCcSsQqTtAa])/g, " $1 ")
    .replace(/,/g, " ")
    .replace(/(\d)-/g, "$1 -")
    .split(/\s+/)
    .filter(Boolean);
}

const segments = (n: number) => Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(n)));

function signedArea(r: readonly UnitPoint[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i += 1) {
    const p = r[i] as UnitPoint;
    const q = r[(i + 1) % r.length] as UnitPoint;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function cleanRing(ring: readonly UnitPoint[]): UnitPoint[] {
  const out: UnitPoint[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (
    out.length > 1 &&
    first &&
    last &&
    Math.abs(first.x - last.x) <= 1e-9 &&
    Math.abs(first.y - last.y) <= 1e-9
  )
    out.pop();
  return out;
}

/**
 * Rings of a cut-out path in the unit square, y down, with lines, cubic and quadratic curves and elliptical
 * arcs flattened so no chord strays more than `tolerance` from the curve. Null when the path is not valid
 * (C-050: the caller cuts the rectangle). Rings with fewer than three points or no area are dropped.
 */
export function cutOutRings(path: string, tolerance = 0.001): UnitPoint[][] | null {
  if (!isValidCutOutPath(path)) return null;
  const tokens = tokenize(path);
  const tol = Math.max(tolerance, 1e-6);
  const rings: UnitPoint[][] = [];
  let ring: UnitPoint[] | null = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let ctrl: UnitPoint | null = null;
  let prev = "";

  const finish = () => {
    if (ring) rings.push(ring);
    ring = null;
  };
  const lineTo = (x: number, y: number) => {
    const r: UnitPoint[] = ring ?? [{ x: cx, y: cy }];
    r.push({ x, y });
    ring = r;
    cx = x;
    cy = y;
  };
  const cubic = (p1: UnitPoint, p2: UnitPoint, p: UnitPoint) => {
    const p0 = { x: cx, y: cy };
    const ddx = Math.max(Math.abs(p0.x - 2 * p1.x + p2.x), Math.abs(p1.x - 2 * p2.x + p.x));
    const ddy = Math.max(Math.abs(p0.y - 2 * p1.y + p2.y), Math.abs(p1.y - 2 * p2.y + p.y));
    const n = segments(Math.sqrt((6 * Math.hypot(ddx, ddy)) / (8 * tol)));
    for (let k = 1; k <= n; k += 1) {
      const s = k / n;
      const u = 1 - s;
      const a = u * u * u;
      const b = 3 * u * u * s;
      const c = 3 * u * s * s;
      const d = s * s * s;
      lineTo(a * p0.x + b * p1.x + c * p2.x + d * p.x, a * p0.y + b * p1.y + c * p2.y + d * p.y);
    }
    ctrl = p2;
  };
  const quadratic = (q: UnitPoint, p: UnitPoint) => {
    const p0 = { x: cx, y: cy };
    const n = segments(Math.sqrt((2 * Math.hypot(p0.x - 2 * q.x + p.x, p0.y - 2 * q.y + p.y)) / (8 * tol)));
    for (let k = 1; k <= n; k += 1) {
      const s = k / n;
      const u = 1 - s;
      lineTo(u * u * p0.x + 2 * u * s * q.x + s * s * p.x, u * u * p0.y + 2 * u * s * q.y + s * s * p.y);
    }
    ctrl = q;
  };
  // SVG endpoint arc to centre parametrisation (SVG 1.1 implementation notes F.6.5, F.6.6)
  const arc = (rxIn: number, ryIn: number, phiDeg: number, large: boolean, sweep: boolean, p: UnitPoint) => {
    const x1 = cx;
    const y1 = cy;
    let rx = Math.abs(rxIn);
    let ry = Math.abs(ryIn);
    if (rx === 0 || ry === 0 || (x1 === p.x && y1 === p.y)) {
      lineTo(p.x, p.y);
      return;
    }
    const phi = (phiDeg * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (x1 - p.x) / 2;
    const dy = (y1 - p.y) / 2;
    const x1p = cos * dx + sin * dy;
    const y1p = -sin * dx + cos * dy;
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
      rx *= Math.sqrt(lambda);
      ry *= Math.sqrt(lambda);
    }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
    const cxp = (coef * rx * y1p) / ry;
    const cyp = (-coef * ry * x1p) / rx;
    const ccx = cos * cxp - sin * cyp + (x1 + p.x) / 2;
    const ccy = sin * cxp + cos * cyp + (y1 + p.y) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number) =>
      Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    else if (sweep && dt < 0) dt += 2 * Math.PI;
    const r = Math.max(rx, ry);
    const step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI;
    const n = segments(Math.abs(dt) / step);
    for (let k = 1; k < n; k += 1) {
      const a = t1 + (dt * k) / n;
      const ex = rx * Math.cos(a);
      const ey = ry * Math.sin(a);
      lineTo(cos * ex - sin * ey + ccx, sin * ex + cos * ey + ccy);
    }
    lineTo(p.x, p.y);
  };

  let i = 0;
  while (i < tokens.length) {
    const letter = tokens[i] as string;
    i += 1;
    const cmd = letter.toUpperCase();
    const rel = letter !== cmd;
    if (cmd === "Z") {
      cx = sx;
      cy = sy;
      finish();
      ctrl = null;
      prev = "Z";
      continue;
    }
    let first = true;
    while (i < tokens.length && NUMBER.test(tokens[i] as string)) {
      const at = i;
      const n = (k: number) => Number(tokens[at + k]);
      const ox = rel ? cx : 0;
      const oy = rel ? cy : 0;
      const pt = (k: number): UnitPoint => ({ x: n(k) + ox, y: n(k + 1) + oy });
      switch (cmd) {
        case "M": {
          const p = pt(0);
          i += 2;
          if (first) {
            finish();
            cx = p.x;
            cy = p.y;
            sx = p.x;
            sy = p.y;
            ring = [p];
          } else lineTo(p.x, p.y);
          ctrl = null;
          break;
        }
        case "L": {
          const p = pt(0);
          i += 2;
          lineTo(p.x, p.y);
          ctrl = null;
          break;
        }
        case "H":
          lineTo(n(0) + ox, cy);
          i += 1;
          ctrl = null;
          break;
        case "V":
          lineTo(cx, n(0) + oy);
          i += 1;
          ctrl = null;
          break;
        case "C": {
          const p1 = pt(0);
          const p2 = pt(2);
          const p = pt(4);
          i += 6;
          cubic(p1, p2, p);
          break;
        }
        case "S": {
          const c = ctrl as UnitPoint | null;
          const p1 = prev === "C" && c ? { x: 2 * cx - c.x, y: 2 * cy - c.y } : { x: cx, y: cy };
          const p2 = pt(0);
          const p = pt(2);
          i += 4;
          cubic(p1, p2, p);
          break;
        }
        case "Q": {
          const q = pt(0);
          const p = pt(2);
          i += 4;
          quadratic(q, p);
          break;
        }
        case "T": {
          const c = ctrl as UnitPoint | null;
          const q = prev === "Q" && c ? { x: 2 * cx - c.x, y: 2 * cy - c.y } : { x: cx, y: cy };
          const p = pt(0);
          i += 2;
          quadratic(q, p);
          break;
        }
        case "A": {
          const p = { x: n(5) + ox, y: n(6) + oy };
          arc(n(0), n(1), n(2), n(3) !== 0, n(4) !== 0, p);
          i += 7;
          ctrl = null;
          break;
        }
      }
      prev = cmd === "S" ? "C" : cmd === "T" ? "Q" : cmd;
      first = false;
    }
  }
  finish();
  return rings.map(cleanRing).filter((r) => r.length >= 3 && Math.abs(signedArea(r)) > 1e-9);
}
