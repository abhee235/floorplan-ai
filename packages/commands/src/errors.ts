// Command errors are written for a model to act on: field, constraint, value received, and a hint.
export interface CommandErrorShape {
  code: string;
  message: string;
  entityId: string | null;
  hint: string | null;
}

export class CommandError extends Error implements CommandErrorShape {
  readonly code: string;
  readonly entityId: string | null;
  readonly hint: string | null;

  constructor(code: string, message: string, entityId: string | null = null, hint: string | null = null) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.entityId = entityId;
    this.hint = hint;
  }

  toJSON(): CommandErrorShape {
    return { code: this.code, message: this.message, entityId: this.entityId, hint: this.hint };
  }
}

export function missingRef(kind: string, id: string, entityId: string | null = null): CommandError {
  return new CommandError(
    "ref.missing",
    `${kind} "${id}" does not resolve`,
    entityId,
    `use get_scene to list existing ${kind}s`,
  );
}

export function precondition(
  code: string,
  message: string,
  entityId: string | null = null,
  hint: string | null = null,
): CommandError {
  return new CommandError(code, message, entityId, hint);
}
