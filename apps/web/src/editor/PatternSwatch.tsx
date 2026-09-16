// A small picture of a plan pattern (W-121), shown beside its name in a list and in the closed field, so
// "Hatched" and "Cross-hatched" are seen rather than imagined. Decoration only: the name carries the meaning.

import type { WallPattern } from "@fpv/ir";
import { type JSX, useId } from "react";

/** Diagonal offsets across the 16-unit box, four units apart: enough to cross the whole cut either way. */
const OFFSETS = [-12, -8, -4, 0, 4, 8, 12];

export function PatternSwatch({ pattern }: { pattern: WallPattern }): JSX.Element {
  // useId's output carries characters a url(#…) reference does not take everywhere
  const clip = `pattern-${useId().replace(/[^\w-]/g, "")}`;
  const hatched = pattern === "hatch" || pattern === "cross-hatch";
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="size-4 text-current">
      <defs>
        <clipPath id={clip}>
          <rect x="1.5" y="4.5" width="13" height="7" />
        </clipPath>
      </defs>
      {hatched ? (
        <g clipPath={`url(#${clip})`} stroke="currentColor" strokeWidth="0.75">
          {OFFSETS.map((o) => (
            <line key={`up${o}`} x1={o} y1={16} x2={o + 16} y2={0} />
          ))}
          {pattern === "cross-hatch"
            ? OFFSETS.map((o) => <line key={`down${o}`} x1={o} y1={0} x2={o + 16} y2={16} />)
            : null}
        </g>
      ) : null}
      <rect
        x="1.5"
        y="4.5"
        width="13"
        height="7"
        fill={pattern === "solid" ? "currentColor" : "none"}
        stroke="currentColor"
      />
    </svg>
  );
}
