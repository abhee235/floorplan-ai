// Naming the open project from outside itself (ADR-020 D2).
import { describe, expect, it } from "vitest";
import { addressIn, PROJECT_PARAM, showAddress, titleFor, withAddress } from "../../src/editor/address.js";

const BASE = "http://127.0.0.1:4360/";
/** A Windows directory, which is what an address is today and why none of this may parse one. */
const WINDOWS = "C:\\Users\\abhis\\Documents\\Floor plans\\boardroom.fpviz";
const POSIX = "/home/abhis/floor plans/boardroom.fpviz";

describe("the address in the URL (ADR-020 D2)", () => {
  it("carries an address through the URL unchanged, whatever is in it", () => {
    for (const address of [WINDOWS, POSIX, "project id 7", "a&b=c?d#e", "café/naïve"]) {
      const href = withAddress(BASE, address);
      expect(addressIn(href), address).toBe(address);
    }
  });

  it("escapes what it puts in, so a path never breaks the query string", () => {
    const href = withAddress(BASE, WINDOWS);
    expect(href).not.toContain("\\");
    expect(href).toContain(`${PROJECT_PARAM}=`);
  });

  it("reads no address as null, including an empty one", () => {
    expect(addressIn(BASE)).toBeNull();
    expect(addressIn(`${BASE}?${PROJECT_PARAM}=`)).toBeNull();
    expect(addressIn(`${BASE}?something=else`)).toBeNull();
    expect(addressIn("not a url at all")).toBeNull();
  });

  it("drops the parameter for a project that has no address yet", () => {
    const withOne = withAddress(BASE, WINDOWS);
    expect(addressIn(withOne)).toBe(WINDOWS);
    const withNone = withAddress(withOne, null);
    expect(addressIn(withNone)).toBeNull();
    expect(withNone).not.toContain(PROJECT_PARAM);
  });

  it("leaves everything else in the URL alone", () => {
    const href = withAddress(`${BASE}?debug=1#somewhere`, POSIX);
    expect(href).toContain("debug=1");
    expect(href).toContain("#somewhere");
    expect(addressIn(href)).toBe(POSIX);
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
    showAddress(WINDOWS, view);
    expect(calls).toHaveLength(1);
    expect(addressIn(calls[0] as string)).toBe(WINDOWS);

    // and saying the same thing twice writes nothing
    showAddress(WINDOWS, view);
    expect(calls).toHaveLength(1);
  });
});

describe("the page title (ADR-020 D2)", () => {
  it("leads with the project's name, so truncated tabs stay distinguishable", () => {
    expect(titleFor("Boardroom task card", false)).toBe("Boardroom task card — floorplan-ai");
    expect(titleFor("Boardroom task card", false).indexOf("Boardroom")).toBeLessThan(2);
  });

  it("marks unsaved work where it is visible at any width", () => {
    expect(titleFor("Studio East", true)).toBe("• Studio East — floorplan-ai");
  });

  it("says Untitled rather than nothing when a project has no name", () => {
    expect(titleFor("   ", false)).toBe("Untitled — floorplan-ai");
  });
});
