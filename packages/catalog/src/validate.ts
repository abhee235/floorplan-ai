// Product validation beyond the shape (spec 02 section 1 "Validation beyond shape").
import { isValidCutOutPath } from "./cutout.js";
import { isOpeningCategory, type Product, REQUIRED_SPECS } from "./schema.js";

export interface CatalogProblem {
  code: string;
  severity: "error" | "warning";
  productId: string | null;
  message: string;
}

/** A display deeper than this is suspicious: probably a stand depth or a unit slip. */
export const DISPLAY_MAX_DEPTH_MM = 300;

export function validateProduct(p: Product): CatalogProblem[] {
  const out: CatalogProblem[] = [];
  const err = (code: string, message: string) =>
    out.push({ code, severity: "error", productId: p.id, message });
  const warn = (code: string, message: string) =>
    out.push({ code, severity: "warning", productId: p.id, message });
  const opening = isOpeningCategory(p.category);
  if (opening && !p.opening)
    err("opening.required", `${p.id}: a ${p.category} product needs an opening spec`);
  if (!opening && p.opening)
    err("opening.unexpected", `${p.id}: only doors and windows carry an opening spec`);
  // O-013: a door or window is never an item; it only ever mounts in a wall
  if (opening && (p.mount.kinds.length !== 1 || p.mount.kinds[0] !== "wall"))
    err("opening.mount", `${p.id}: doors and windows mount only in walls`);
  if (p.mount.vesa && !p.mount.kinds.includes("wall"))
    err("mount.vesa", `${p.id}: a VESA pattern implies wall mounting; add "wall" to mount.kinds`);
  if (p.category === "display" && p.dims.d > DISPLAY_MAX_DEPTH_MM)
    warn("dims.implausible", `${p.id}: a display ${p.dims.d} mm deep is unusual; check the unit`);
  // C-050: an unparseable cut-out path is reported; the engine cuts a rectangle for it
  if (
    p.opening?.cutOutPath !== null &&
    p.opening?.cutOutPath !== undefined &&
    !isValidCutOutPath(p.opening.cutOutPath)
  )
    warn("opening.cutOutPath", `${p.id}: cut-out path is not a valid SVG path; the rectangle is used`);
  const required = REQUIRED_SPECS[p.category] ?? [];
  const missing = required.filter((k) => !(k in p.specs));
  if (missing.length > 0)
    warn("specs.missing", `${p.id}: ${p.category} products should carry specs ${missing.join(", ")}`);
  if (p.price && p.price.expiresAt <= p.price.capturedAt)
    err("price.expiry", `${p.id}: a price expires after it is captured`);
  if (p.verification.status === "verified" && p.verification.sources.length === 0)
    err("verification.sources", `${p.id}: a verified product names at least one source`);
  return out;
}

export function hasErrors(problems: readonly CatalogProblem[]): boolean {
  return problems.some((p) => p.severity === "error");
}
