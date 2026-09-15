import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Project, type Project as ProjectT } from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("../../../tools/fixtures/six-wall-room.fpviz/", import.meta.url));

export const FIXTURE_TEXT = readFileSync(`${fixtureDir}project.json`, "utf8");
export const EXPECTED = JSON.parse(readFileSync(`${fixtureDir}expected.json`, "utf8")) as {
  wallCount: number;
  joinCount: number;
  wallLengthsMm: Record<string, number>;
  wallCompassLeftSide: Record<string, "north" | "south" | "east" | "west">;
  detectedRoomPolygonWithoutThreshold: { x: number; y: number }[];
  detectedRoomAreaMm2WithoutThreshold: number;
  detectedRoomAreaMm2WithThreshold: number;
};

/** A fresh deep copy of the six-wall fixture for each test. */
export function fixture(): ProjectT {
  return Project.parse(JSON.parse(FIXTURE_TEXT));
}

export const LEVEL = "level_000000";
