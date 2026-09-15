// Serialisation (spec 01 section 8, ADR-012 D2): keys in schema declaration order, two-space indent,
// explicit nulls, records sorted alphabetically, unknown fields preserved, forward-only migrations.
import type { ZodTypeAny } from "zod";
import { z } from "zod";
import { MIGRATIONS, type Migration, MigrationError, migrate, type RawDocument } from "./migrations.js";
import { Project, SCHEMA_VERSION } from "./schema.js";

const UNKNOWN_KEY = "__unknown";

// ---- key ordering ---------------------------------------------------------

function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let s = schema;
  for (;;) {
    const def = s._def as { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny };
    if (def.typeName === "ZodNullable" || def.typeName === "ZodOptional" || def.typeName === "ZodDefault") {
      s = def.innerType as ZodTypeAny;
      continue;
    }
    if (def.typeName === "ZodEffects") {
      s = def.schema as ZodTypeAny;
      continue;
    }
    return s;
  }
}

function pickUnionOption(schema: ZodTypeAny, value: Record<string, unknown>): ZodTypeAny | null {
  const def = schema._def as {
    typeName?: string;
    discriminator?: string;
    options?: ZodTypeAny[] | Map<unknown, ZodTypeAny>;
  };
  if (def.typeName === "ZodDiscriminatedUnion" && def.discriminator) {
    const options = def.options instanceof Map ? [...def.options.values()] : (def.options ?? []);
    for (const opt of options) {
      const shape = (unwrap(opt) as z.AnyZodObject).shape as Record<string, ZodTypeAny>;
      const lit = shape[def.discriminator]?._def as { value?: unknown } | undefined;
      if (lit && lit.value === value[def.discriminator]) return opt;
    }
    return null;
  }
  if (def.typeName === "ZodUnion") {
    for (const opt of (def.options as ZodTypeAny[]) ?? []) {
      if (opt.safeParse(value).success) return opt;
    }
  }
  return null;
}

/** Recursively rebuild a value with object keys in schema order; record keys sorted; unknown keys last, sorted. */
export function orderBySchema(value: unknown, schema: ZodTypeAny): unknown {
  if (value === null || value === undefined) return value ?? null;
  const s = unwrap(schema);
  const def = s._def as {
    typeName?: string;
    type?: ZodTypeAny;
    valueType?: ZodTypeAny;
    unknownKeys?: string;
  };
  if (def.typeName === "ZodArray" && Array.isArray(value)) {
    return value.map((v) => orderBySchema(v, def.type as ZodTypeAny));
  }
  if (
    (def.typeName === "ZodDiscriminatedUnion" || def.typeName === "ZodUnion") &&
    typeof value === "object"
  ) {
    const opt = pickUnionOption(s, value as Record<string, unknown>);
    return opt ? orderBySchema(value, opt) : value;
  }
  if (def.typeName === "ZodRecord" && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj).sort()) out[k] = orderBySchema(obj[k], def.valueType as ZodTypeAny);
    return out;
  }
  if (def.typeName === "ZodObject" && typeof value === "object") {
    const shape = (s as z.AnyZodObject).shape as Record<string, ZodTypeAny>;
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      out[key] = key in obj ? orderBySchema(obj[key], shape[key] as ZodTypeAny) : null;
    }
    const extra = Object.keys(obj)
      .filter((k) => !(k in shape))
      .sort();
    for (const k of extra) out[k] = obj[k];
    return out;
  }
  return value;
}

// ---- unknown field preservation ------------------------------------------

const ENTITY_COLLECTIONS = ["levels", "walls", "openings", "rooms", "items", "zones"] as const;

function captureUnknown(
  raw: Record<string, unknown>,
  shape: Record<string, ZodTypeAny>,
): Record<string, unknown> {
  const unknown: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) if (!(k in shape)) unknown[k] = raw[k];
  return unknown;
}

/** Move unknown keys of the root and of each entity into properties.__unknown so a newer file survives an older tool (P-037). */
function stashUnknown(raw: RawDocument): { raw: RawDocument; count: number } {
  let count = 0;
  const rootShape = Project.shape as Record<string, ZodTypeAny>;
  const out: RawDocument = { ...raw };
  const rootUnknown = captureUnknown(raw, rootShape);
  for (const k of Object.keys(rootUnknown)) delete out[k];
  if (Object.keys(rootUnknown).length) {
    count += Object.keys(rootUnknown).length;
    out.properties = {
      ...((raw.properties as Record<string, string>) ?? {}),
      [UNKNOWN_KEY]: JSON.stringify(rootUnknown),
    };
  }
  for (const coll of ENTITY_COLLECTIONS) {
    const list = raw[coll];
    if (!Array.isArray(list)) continue;
    const elem = unwrap(
      (rootShape[coll] as z.ZodArray<ZodTypeAny>)._def.type as ZodTypeAny,
    ) as z.AnyZodObject;
    const shape = elem.shape as Record<string, ZodTypeAny>;
    out[coll] = list.map((entity) => {
      if (!entity || typeof entity !== "object") return entity;
      const e = entity as Record<string, unknown>;
      const unknown = captureUnknown(e, shape);
      if (!Object.keys(unknown).length) return e;
      count += Object.keys(unknown).length;
      const kept: Record<string, unknown> = {};
      for (const k of Object.keys(e)) if (k in shape) kept[k] = e[k];
      kept.properties = {
        ...((e.properties as Record<string, string>) ?? {}),
        [UNKNOWN_KEY]: JSON.stringify(unknown),
      };
      return kept;
    });
  }
  return { raw: out, count };
}

/** Inverse of stashUnknown, applied on serialise so round trips keep foreign fields. */
function restoreUnknown(obj: Record<string, unknown>): Record<string, unknown> {
  const props = obj.properties as Record<string, string> | undefined;
  if (!props || !(UNKNOWN_KEY in props)) return obj;
  const { [UNKNOWN_KEY]: json, ...rest } = props;
  let extra: Record<string, unknown> = {};
  try {
    extra = JSON.parse(json ?? "{}") as Record<string, unknown>;
  } catch {
    extra = {};
  }
  return { ...obj, properties: rest, ...extra };
}

// ---- public API -----------------------------------------------------------

export function serialize(project: Project): string {
  const stamped: Project = { ...project, schemaVersion: SCHEMA_VERSION };
  const ordered = orderBySchema(stamped, Project) as Record<string, unknown>;
  let root = restoreUnknown(ordered);
  for (const coll of ENTITY_COLLECTIONS) {
    const list = root[coll];
    if (Array.isArray(list))
      root = { ...root, [coll]: list.map((e) => restoreUnknown(e as Record<string, unknown>)) };
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

export interface DeserializeOk {
  ok: true;
  project: Project;
  migrated: boolean;
  unknownFieldCount: number;
}
export interface DeserializeFail {
  ok: false;
  problems: { code: string; message: string }[];
}

export function deserialize(
  text: string,
  registry: Map<number, Migration> = MIGRATIONS,
): DeserializeOk | DeserializeFail {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, problems: [{ code: "file.json", message: (e as Error).message }] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, problems: [{ code: "file.shape", message: "root must be an object" }] };
  }
  let migrated = false;
  let doc = raw as RawDocument;
  try {
    const m = migrate(doc, registry);
    doc = m.raw;
    migrated = m.migrated;
  } catch (e) {
    if (e instanceof MigrationError) return { ok: false, problems: [{ code: e.code, message: e.message }] };
    throw e;
  }
  const stashed = stashUnknown(doc);
  const parsed = Project.safeParse(stashed.raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 20)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, problems: [{ code: "file.shape", message: issues.join("; ") }] };
  }
  return { ok: true, project: parsed.data, migrated, unknownFieldCount: stashed.count };
}
