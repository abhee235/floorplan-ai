// The two live regions the editor speaks through (ADR-017 D5). Gesture feedback is polite and coalesced, so
// a stream of pointer moves announces once rather than flooding a screen reader; refusals are assertive and
// immediate. Anything with a textContent satisfies LiveRegion, so the rules are testable without a DOM.

/** The one property the announcer writes; an HTMLElement satisfies it. */
export interface LiveRegion {
  textContent: string | null;
}

export interface AnnouncerOptions {
  /** Defers a polite announcement so a burst coalesces into one; announcements are immediate without it. */
  defer?: (flush: () => void) => void;
}

export class Announcer {
  private readonly politeRegion: LiveRegion;
  private readonly assertiveRegion: LiveRegion;
  private readonly defer: ((flush: () => void) => void) | null;
  private pending: string | null = null;
  private scheduled = false;

  constructor(regions: { polite: LiveRegion; assertive: LiveRegion }, options: AnnouncerOptions = {}) {
    this.politeRegion = regions.polite;
    this.assertiveRegion = regions.assertive;
    this.defer = options.defer ?? null;
  }

  /** Gesture feedback: the length and angle being drawn, what a snap caught, what was selected. */
  say(text: string): void {
    this.pending = text;
    if (!this.defer) {
      this.flush();
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    this.defer(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  /** A refusal or a validation error: never waits behind gesture feedback. */
  alert(text: string): void {
    this.assertiveRegion.textContent = distinct(this.assertiveRegion.textContent, text);
  }

  /** Writes any deferred announcement now. */
  flush(): void {
    if (this.pending === null) return;
    const text = this.pending;
    this.pending = null;
    this.politeRegion.textContent = distinct(this.politeRegion.textContent, text);
  }

  clear(): void {
    this.pending = null;
    this.politeRegion.textContent = "";
    this.assertiveRegion.textContent = "";
  }
}

/** A screen reader skips a region whose text did not change, so saying the same line twice needs one
 *  invisible character of difference; it alternates, so the third identical line is announced too. */
function distinct(current: string | null, next: string): string {
  const now = current ?? "";
  if (now.replace(/ +$/, "") !== next) return next;
  return now.endsWith(" ") ? next : `${next} `;
}
