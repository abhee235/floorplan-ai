// @fpv/ir: Scene IR schema, validation, normalisation, derived values, serialisation (docs/spec/01-scene-ir.md).
export const PACKAGE = "ir" as const;
export * from "./defaults.js";
export * as derive from "./derive.js";
export * from "./finishes.js";
export * from "./ids.js";
export * from "./migrations.js";
export * from "./normalize.js";
export * as poly from "./poly.js";
export * from "./schema.js";
export * from "./serialize.js";
export * from "./validate.js";
