import { describe, expect, it } from "vitest";
import { parseBrief } from "../src/index.js";

describe("parseBrief (spec 04 create_room_from_brief)", () => {
  it("the task card: 10-seat boardroom, 8 by 5 metres, video conferencing", () => {
    expect(parseBrief("10-seat boardroom, 8 by 5 metres, video conferencing")).toEqual({
      purpose: "boardroom",
      capacity: 10,
      widthMm: 8000,
      depthMm: 5000,
      av: ["video-conferencing"],
      name: "Boardroom",
      assumed: [],
    });
  });

  it("reads other ways of writing size and seats", () => {
    expect(parseBrief("huddle room for four, 3x2.5m, Teams display")).toMatchObject({
      purpose: "huddle",
      capacity: 4,
      widthMm: 3000,
      depthMm: 2500,
      av: ["video-conferencing", "display"],
    });
    expect(parseBrief("Training room 24 people 12000 x 10000 mm")).toMatchObject({
      purpose: "training",
      capacity: 24,
      widthMm: 12000,
      depthMm: 10000,
    });
    expect(parseBrief("conference room, 20 ft by 12 ft, eight seats")).toMatchObject({
      purpose: "meeting",
      capacity: 8,
      widthMm: 6096,
      depthMm: 3658,
    });
  });

  it("assumes what is missing and says so", () => {
    const sized = parseBrief("boardroom 7 by 4 m");
    expect(sized.capacity).toBe(8);
    expect(sized.assumed).toEqual(["seats not stated; assumed 8"]);
    const bare = parseBrief("a room for 6 with a screen");
    expect(bare).toMatchObject({ purpose: "meeting", capacity: 6, av: ["display"] });
    expect(bare.assumed).toEqual([
      "purpose not stated; assumed meeting",
      "size not stated; assumed 5.4 by 3.4 m",
    ]);
    expect(bare.widthMm * bare.depthMm).toBeGreaterThanOrEqual(18e6);
    expect(parseBrief("boardroom with 40 m2 floor").assumed).toEqual([
      "seats not stated; assumed 11",
      "size not stated; assumed 8 by 5 m",
    ]);
  });
});
