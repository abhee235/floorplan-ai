// Ids are "<type>_<6 base36 chars>" (ADR-001 D4). Generators are injectable so tests are deterministic.

export type IdType = "level" | "wall" | "opening" | "room" | "item" | "zone" | "annot";

export interface IdGenerator {
  next(type: IdType): string;
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function suffix(rand: () => number): string {
  let s = "";
  for (let i = 0; i < 6; i += 1) s += ALPHABET[Math.floor(rand() * 36)] ?? "0";
  return s;
}

/** Random ids, unique within a project; `taken` is consulted so ids are never reused (ADR-001 D4). */
export function randomIdGenerator(
  taken: Set<string> = new Set(),
  rand: () => number = Math.random,
): IdGenerator {
  return {
    next(type) {
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const id = `${type}_${suffix(rand)}`;
        if (!taken.has(id)) {
          taken.add(id);
          return id;
        }
      }
      throw new Error(`could not allocate a unique id for ${type}`);
    },
  };
}

/** Sequential ids for tests and fixtures: wall_000001, wall_000002, ... */
export function sequentialIdGenerator(start = 1): IdGenerator {
  const counters = new Map<IdType, number>();
  return {
    next(type) {
      const n = counters.get(type) ?? start;
      counters.set(type, n + 1);
      return `${type}_${n.toString(36).padStart(6, "0")}`;
    },
  };
}

export const ID_PATTERN = /^(level|wall|opening|room|item|zone|annot)_[0-9a-z]{6}$/;

export function idType(id: string): IdType | null {
  const m = ID_PATTERN.exec(id);
  return (m?.[1] as IdType | undefined) ?? null;
}
