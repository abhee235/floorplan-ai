// @fpv/geometry: 2D kernel: footprints with symmetric joins, arcs, booleans, room detection, magnetism, triangulation (spec 05).
export const PACKAGE = "geometry" as const;
export { poly } from "@fpv/ir";
export * from "./arcs.js";
export * from "./booleans.js";
export * from "./detect.js";
export * from "./footprints.js";
export * from "./lines.js";
export * from "./magnetism.js";
export * from "./placement.js";
export { TOL } from "./tolerances.js";
export * from "./triangulate.js";
