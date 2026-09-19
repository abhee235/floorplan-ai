// Naming the open project from outside itself (ADR-020 D2): `/p/<project id>`.
//
// The first version of this put the project's DIRECTORY in a query parameter. That worked and was
// wrong: it wrote the machine's layout into browser history and bookmarks, broke the moment a folder
// moved, and could not be sent to anyone. ADR-020 D1 asked for an opaque address and then handed it the
// least opaque thing available.
//
// A project now carries its own id, so that is what a link says. Nothing here knows where a project
// lives; the host resolves an id to a location, which is the whole point — the same link keeps working
// after the folder is dragged somewhere else, and it says nothing about the machine it was made on.

/** The path a project's URL takes. */
export const PROJECT_PREFIX = "/p/";
/** Twelve base36 characters, as minted in the IR. Anything else is not a project id. */
const ID = /^[0-9a-z]{12}$/;

/** The project a URL names, or null when it names none. */
export function projectIdIn(href: string): string | null {
  let path: string;
  try {
    path = new URL(href).pathname;
  } catch {
    return null;
  }
  if (!path.startsWith(PROJECT_PREFIX)) return null;
  // Only the segment after the prefix; anything deeper is not an address this understands.
  const rest = path.slice(PROJECT_PREFIX.length).split("/")[0] ?? "";
  const id = decodeURIComponent(rest);
  return ID.test(id) ? id : null;
}

/** The same URL pointing at a project, or at the root when there is none to point at. */
export function withProjectId(href: string, id: string | null): string {
  const url = new URL(href);
  url.pathname = id === null || id.length === 0 ? "/" : `${PROJECT_PREFIX}${id}`;
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

/** The project this tab's URL names. */
export function projectAsked(location: { href: string } = window.location): string | null {
  return projectIdIn(location.href);
}

/**
 * Put the open project in the address bar.
 *
 * `replaceState`, never `pushState`: a history entry per project would put "reopen the previous
 * project" on the Back button, and Back is pressed by accident. Discarding unsaved work to a stray
 * keystroke is not a trade worth the convenience (ADR-020 D2).
 */
export function showProject(
  id: string | null,
  view: { location: { href: string }; history: { replaceState: History["replaceState"] } } = window,
): void {
  const next = withProjectId(view.location.href, id);
  if (next === view.location.href) return;
  view.history.replaceState(null, "", next);
}
