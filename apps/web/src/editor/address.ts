// Naming the open project from outside itself (ADR-020 D2).
//
// The editor served one URL and showed whatever the host had open, so two tabs were identical, a
// bookmark meant "whatever that host holds", and nothing could ask for a different project. The address
// goes in the URL and the name goes in the page title.
//
// The address is opaque here, exactly as ADR-020 D1 requires: today it is a directory path, in a hosted
// store it will be an identifier, and nothing in this file parses, splits or joins one. It is a string
// that goes into a query parameter and comes back out.

/** The query parameter carrying the open project's address. */
export const PROJECT_PARAM = "project";

/** The address a URL asks for, or null when it names none. */
export function addressIn(href: string): string | null {
  try {
    const value = new URL(href).searchParams.get(PROJECT_PARAM);
    return value !== null && value.length > 0 ? value : null;
  } catch {
    // not a URL we can read; the same as asking for nothing
    return null;
  }
}

/**
 * The same URL with the address set, or removed when there is none — a project that has never been
 * saved has no address, so the parameter goes rather than standing empty.
 */
export function withAddress(href: string, address: string | null): string {
  const url = new URL(href);
  if (address === null || address.length === 0) url.searchParams.delete(PROJECT_PARAM);
  else url.searchParams.set(PROJECT_PARAM, address);
  return url.toString();
}

/**
 * What the browser tab says. The name first, because a row of tabs is truncated from the right and the
 * name is the part that tells them apart; the unsaved mark leads, where it is visible at any width.
 */
export function titleFor(name: string, modified: boolean): string {
  const called = name.trim().length > 0 ? name.trim() : "Untitled";
  return `${modified ? "• " : ""}${called} — floorplan-ai`;
}

/** What this tab's URL asks for. */
export function addressAsked(location: { href: string } = window.location): string | null {
  return addressIn(location.href);
}

/**
 * Put the open project's address in the address bar.
 *
 * `replaceState`, never `pushState`: a history entry per project would put "reopen the previous
 * project" on the Back button, and Back is pressed by accident. Discarding unsaved work to a stray
 * keystroke is not a trade worth the convenience (ADR-020 D2).
 */
export function showAddress(
  address: string | null,
  view: { location: { href: string }; history: { replaceState: History["replaceState"] } } = window,
): void {
  const next = withAddress(view.location.href, address);
  if (next === view.location.href) return;
  view.history.replaceState(null, "", next);
}
