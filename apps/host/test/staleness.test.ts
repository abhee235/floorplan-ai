// Whether the host notices that it is running code older than what is on disk (P3-6 follow-up).
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { staleness, stalenessNote } from "../src/staleness.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A checkout-shaped directory whose files can be given exact times. */
function checkout(files: Record<string, number>): string {
  const root = mkdtempSync(join(tmpdir(), "fpv-stale-"));
  roots.push(root);
  for (const [path, at] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "x");
    utimesSync(full, new Date(at), new Date(at));
  }
  return root;
}

const HOUR = 3_600_000;
const NOON = Date.UTC(2026, 8, 18, 12);

describe("noticing a host that is behind its own source", () => {
  it("says nothing when nothing has changed since it started", () => {
    const root = checkout({
      "packages/commands/src/reducers/zones.ts": NOON - HOUR,
      "apps/host/src/bridge.ts": NOON - HOUR,
    });
    const s = staleness(root, NOON);
    expect(s.hostBehind).toBe(false);
    expect(stalenessNote(s)).toBeNull();
  });

  it("says so, and names the file, when a reducer changed after it started", () => {
    const root = checkout({
      "packages/commands/src/reducers/zones.ts": NOON + HOUR,
      "apps/host/src/bridge.ts": NOON - HOUR,
    });
    const s = staleness(root, NOON);
    expect(s.hostBehind).toBe(true);
    expect(s.newest).toBe("packages/commands/src/reducers/zones.ts");
    expect(stalenessNote(s)).toContain("Restart it");
  });

  it("ignores a test that changed, because a test cannot change what the host does", () => {
    const root = checkout({
      "packages/commands/src/reducers/zones.ts": NOON - HOUR,
      "packages/commands/test/zones.test.ts": NOON + HOUR,
    });
    expect(staleness(root, NOON).hostBehind).toBe(false);
  });

  it("notices a built app older than the source it was built from", () => {
    const root = checkout({
      "apps/web/src/editor/EditorShell.tsx": NOON + HOUR,
      "apps/web/dist/index.html": NOON,
      "packages/commands/src/index.ts": NOON - HOUR,
    });
    const s = staleness(root, NOON + 2 * HOUR);
    expect(s.hostBehind).toBe(false);
    expect(s.buildBehind).toBe(true);
    expect(stalenessNote(s)).toContain("built");
  });

  it("says both at once when both are true", () => {
    const root = checkout({
      "packages/commands/src/index.ts": NOON + HOUR,
      "apps/web/src/main.ts": NOON + HOUR,
      "apps/web/dist/index.html": NOON,
    });
    const note = stalenessNote(staleness(root, NOON)) ?? "";
    expect(note).toContain("Build it and restart the host");
  });

  it("says nothing at all where there is no source to compare with", () => {
    const root = checkout({ "some/packaged/app.js": NOON });
    const s = staleness(root, NOON);
    expect(s).toEqual({ hostBehind: false, buildBehind: false, newest: null });
    expect(stalenessNote(s)).toBeNull();
  });
});
