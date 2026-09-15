// Mesh rotation matrices (ADR-008 D1, P-025): row-major 3x3, identity when null, near-integers snapped
// on the way out so a file never carries 0.9999999 for 1.

export const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const SNAP = 1e-6;

/** Values within 1e-6 of 0, 1 or -1 become exactly that (P-025). */
export function snapMatrix(m: readonly number[]): number[] {
  return m.map((v) => {
    for (const target of [0, 1, -1]) if (Math.abs(v - target) < SNAP) return target;
    return v;
  });
}

/** Null when the matrix is the identity after snapping; the snapped matrix otherwise. */
export function normaliseMeshRotation(m: readonly number[] | null): number[] | null {
  if (!m) return null;
  const s = snapMatrix(m);
  return s.every((v, i) => v === IDENTITY[i]) ? null : s;
}

/** Strict parse of nine numbers (C-017 reversed): anything else is an error, never a silent identity. */
export function parseMatrix(text: string): number[] {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 9) throw new Error(`modelRotation needs exactly 9 values, got ${parts.length}`);
  const values = parts.map((p) => Number(p));
  const bad = values.findIndex((v) => !Number.isFinite(v));
  if (bad >= 0) throw new Error(`modelRotation value ${bad + 1} is not a number: ${parts[bad]}`);
  return snapMatrix(values);
}
