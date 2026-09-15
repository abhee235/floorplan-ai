// Camera clipping from the project bounds (ADR-003 D4, ledger S-050 simplified).
export interface Clipping {
  near: number;
  far: number;
}

/**
 * near = max(0.05 m, distance / 1000), far = distance + diagonal * 4, where distance is from the camera
 * to the bounds centre and diagonal is the bounds diagonal. An empty project gets a 100 m room.
 */
export function clippingFor(distance: number, diagonal: number): Clipping {
  const diag = diagonal > 0 ? diagonal : 100;
  const near = Math.max(0.05, distance / 1000);
  const far = Math.max(near * 10, distance + diag * 4);
  return { near, far };
}
