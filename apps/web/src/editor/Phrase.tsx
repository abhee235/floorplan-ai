// Rendering a Phrase (tools.ts): prose with the key names drawn as keys.
//
// This exists so the four places that show a key — the tool options bar, the rail's tooltips, the status
// bar and the properties panel — all draw one the same way. Before this, "Hold Shift to add to the
// selection" put Shift in the same grey as the word "to", so nothing on screen suggested there was a key
// to press at all.

import type { JSX } from "react";
import { Kbd } from "@/components/ui/kbd";
import type { Phrase } from "./tools.js";

/** A phrase with its keys drawn as keys. Inline, so it sits inside a sentence. */
export function Keyed({ phrase }: { phrase: Phrase }): JSX.Element {
  return (
    <>
      {/* The index is a safe key here: a Phrase is a literal in tools.ts and never reorders, and the parts
          carry no state of their own, so there is nothing for React to mismatch even if one did. */}
      {phrase.map((part, i) =>
        "key" in part ? <Kbd key={i}>{part.key}</Kbd> : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}
