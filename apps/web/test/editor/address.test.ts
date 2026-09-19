// Naming the open project from outside itself (ADR-020 D2): `/p/<project id>`.
import { describe, expect, it } from "vitest";
import {
  PROJECT_PREFIX,
  projectIdIn,
  showProject,
  titleFor,
  withProjectId,
} from "../../src/editor/address.js";

const BASE = "http://127.0.0.1:4360/";
const ID = "g0z9i3cvo7qx";

describe("the project in the URL (ADR-020 D2)", () => {
  it("carries a project id and reads it back", () => {
    const href = withProjectId(BASE, ID);
    expect(href).toBe(`http://127.0.0.1:4360${PROJECT_PREFIX}${ID}`);
    expect(projectIdIn(href)).toBe(ID);
  });

  it("says nothing about the machine it was made on", () => {
    // The whole reason this replaced a query parameter holding a directory.
    const href = withProjectId(BASE, ID);
    for (const leak of ["Users", "abhis", "C:", "\\", "Documents", ".fpviz"])
      expect(href, leak).not.toContain(leak);
  });

  it("reads no project where there is none", () => {
    expect(projectIdIn(BASE)).toBeNull();
    expect(projectIdIn(`${BASE}p/`)).toBeNull();
    expect(projectIdIn(`${BASE}something/else`)).toBeNull();
    expect(projectIdIn("not a url at all")).toBeNull();
  });

  it("refuses anything that is not a project id, rather than asking the host about it", () => {
    for (const bad of [
      "short",
      "UPPERCASE123",
      "twelve-chars",
      "../../etc/passwd",
      "C%3A%5CUsers%5Cabhis",
      "g0z9i3cvo7qxg0z9i3cvo7qx",
    ])
      expect(projectIdIn(`${BASE}p/${encodeURIComponent(bad)}`), bad).toBeNull();
  });

  it("ignores anything deeper than the project itself", () => {
    expect(projectIdIn(`${BASE}p/${ID}/something`)).toBe(ID);
  });

  it("goes back to the root for a project with no id to show", () => {
    const at = withProjectId(`${BASE}p/${ID}`, null);
    expect(new URL(at).pathname).toBe("/");
    expect(projectIdIn(at)).toBeNull();
  });

  it("leaves the query and the fragment alone", () => {
    const href = withProjectId(`${BASE}?debug=1#somewhere`, ID);
    expect(href).toContain("debug=1");
    expect(href).toContain("#somewhere");
    expect(projectIdIn(href)).toBe(ID);
  });

  it("replaces the history entry rather than adding one", () => {
    // Back must never mean "reopen the previous project": it is pressed by accident, and unsaved work
    // would go with it (ADR-020 D2).
    const calls: string[] = [];
    const view = {
      location: { href: BASE },
      history: {
        replaceState: ((_s: unknown, _t: string, url: string) => {
          calls.push(url);
          view.location.href = url;
        }) as unknown as History["replaceState"],
      },
    };
    showProject(ID, view);
    expect(calls).toHaveLength(1);
    expect(projectIdIn(calls[0] as string)).toBe(ID);

    // and saying the same thing twice writes nothing
    showProject(ID, view);
    expect(calls).toHaveLength(1);
  });
});

describe("the page title (ADR-020 D2)", () => {
  it("leads with the project's name, so truncated tabs stay distinguishable", () => {
    expect(titleFor("Boardroom task card", false)).toBe("Boardroom task card — floorplan-ai");
  });

  it("marks unsaved work where it is visible at any width", () => {
    expect(titleFor("Studio East", true)).toBe("• Studio East — floorplan-ai");
  });

  it("says Untitled rather than nothing when a project has no name", () => {
    expect(titleFor("   ", false)).toBe("Untitled — floorplan-ai");
  });
});
