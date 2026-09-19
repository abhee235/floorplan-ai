// The Space Designer's prompt: that it says the things the bad run showed were missing, and that it
// says nothing about a tool this session does not have.
//
// A prompt test cannot prove a model will obey. It can prove the sentence is there to be obeyed,
// which is the half that was failing: the old prompt described an office in eight lines and never
// mentioned a bedroom, a scale, or the idea of designing before drawing.
import { describe, expect, it } from "vitest";
import { DESIGNER_SYSTEM, designerSystem } from "../src/index.js";
import { join, section } from "../src/roles/sections.js";

describe("building a prompt out of sections", () => {
  it("drops a section whose every line was ruled out, and bullets the rest", () => {
    expect(section("# Nothing", [null, null])).toBeNull();
    expect(section("# Something", ["one", null, "two"])).toBe("# Something\n- one\n- two");
    // an indented line is a table row or an example, and keeps its shape
    expect(section("# Sizes", ["  bedroom 3000 x 3600"])).toBe("# Sizes\n  bedroom 3000 x 3600");
    expect(join([null, "a", null, "b"])).toBe("a\n\nb");
  });
});

describe("what the prompt tells the model", () => {
  const full = designerSystem({ rules: true, viewer: true, vision: true });

  it("gives the units, the axes and how an id is come by", () => {
    expect(full).toMatch(/Lengths are millimetres/);
    expect(full).toMatch(/North is \+y/);
    expect(full).toMatch(/never invent one/i);
  });

  it("says to design before drawing, and in what order to draw", () => {
    expect(full).toMatch(/Design the whole thing on paper first/);
    expect(full).toMatch(/Do the arithmetic/);
    expect(full).toMatch(/shell/i);
    expect(full).toMatch(/Do not draw one room completely and then start the next/);
  });

  it("carries the sizes a home is made of, which is what the office prompt never had", () => {
    expect(full).toMatch(/double bedroom 3000 x 3600/);
    expect(full).toMatch(/kitchen 2400 x 3600/);
    expect(full).toMatch(/bathroom with a shower 1800 x 2400/);
    expect(full).toMatch(/under 9 m²/);
    // and the word that was read as a corridor
    expect(full).toMatch(/an Indian brief a "hall" is the living room/);
  });

  it("names the two failures the run showed: orphaned walls and churn", () => {
    expect(full).toMatch(/Deleting a room does not delete its walls/);
    expect(full).toMatch(/creating and deleting the same thing a third time/);
  });

  it("asks for an honest summary rather than a hopeful one", () => {
    expect(full).toMatch(/Report what happened, not what you meant to happen/);
    expect(full).toMatch(/do not hedge work that is done/i);
  });

  it("leaves out what this session cannot do", () => {
    const bare = designerSystem({});
    expect(bare).not.toMatch(/render gives you a picture/);
    expect(bare).not.toMatch(/furnish_room lays out a whole room/);
    expect(bare).toMatch(/no rules pack, so there are no recipes/);

    const blind = designerSystem({ viewer: true, vision: false });
    expect(blind).toMatch(/you cannot see images in this session/);
    expect(blind).not.toMatch(/render gives you a picture/);

    expect(full).toMatch(/render gives you a picture/);
    expect(designerSystem({ sourceImage: true })).toMatch(/A raster plan has no scale/);
    expect(full).not.toMatch(/A raster plan has no scale/);
  });

  it("is what the default constant is, and is long enough to be worth reading", () => {
    expect(DESIGNER_SYSTEM).toBe(full);
    const words = full.split(/\s+/).length;
    expect(words).toBeGreaterThan(700);
    expect(words).toBeLessThan(2200);
  });
});
