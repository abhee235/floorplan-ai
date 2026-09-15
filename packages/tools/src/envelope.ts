// Result envelope and errors shared by every tool (spec 04 section 1, ADR-006 D4).
import type { ChangeSet } from "@fpv/commands";
import type { Problem } from "@fpv/ir";

export interface ToolErrorShape {
  code: string;
  message: string;
  entityId: string | null;
  hint: string | null;
}

export interface ToolOk<T = unknown> {
  ok: true;
  result: T;
  warnings: string[];
  problems: Problem[];
  changed: ChangeSet | null;
}

export interface ToolFail {
  ok: false;
  error: ToolErrorShape;
  warnings: string[];
}

export type ToolResult<T = unknown> = ToolOk<T> | ToolFail;

/** Thrown inside a tool; the registry turns it into a ToolFail. */
export class ToolError extends Error implements ToolErrorShape {
  readonly code: string;
  readonly entityId: string | null;
  readonly hint: string | null;
  constructor(code: string, message: string, entityId: string | null = null, hint: string | null = null) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.entityId = entityId;
    this.hint = hint;
  }
  toJSON(): ToolErrorShape {
    return { code: this.code, message: this.message, entityId: this.entityId, hint: this.hint };
  }
}

/** A tool that needs a service this session does not have (ADR-006 D2). */
export function unavailable(tool: string, because: string, hint: string | null = null): ToolError {
  return new ToolError("unavailable", `${tool} is unavailable because ${because}`, null, hint);
}

export function invalidArg(field: string, message: string, hint: string | null = null): ToolError {
  return new ToolError("args.invalid", `${field}: ${message}`, null, hint);
}

/** Results larger than this paginate (ADR-005 D8). */
export const RESULT_CAP_BYTES = 256 * 1024;
export const PAGE_SIZE = 100;

export interface Page<T> {
  page: T[];
  cursor: string | null;
  truncated: boolean;
}

/** Offset pagination with an opaque cursor; the cursor is the offset in base 36. */
export function paginate<T>(items: readonly T[], cursor: string | undefined, pageSize = PAGE_SIZE): Page<T> {
  const offset = cursor ? Number.parseInt(cursor, 36) : 0;
  if (!Number.isFinite(offset) || offset < 0)
    throw invalidArg(
      "cursor",
      `"${cursor}" is not a cursor from a previous call`,
      "omit cursor to start over",
    );
  const page = items.slice(offset, offset + pageSize);
  const next = offset + pageSize;
  const truncated = next < items.length;
  return { page, cursor: truncated ? next.toString(36) : null, truncated };
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}
