// Door and window cut-out paths (spec 02 section 1, C-050): an SVG path in the unit square, y down.
// An unparseable path is reported and treated as the rectangle; it is never silently replaced in the
// record, so the author can see and fix it.

/** Arguments each command takes per repetition; Z takes none. */
const ARITY: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  T: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  A: 7,
  Z: 0,
};
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * True when the path parses as SVG path commands with complete argument groups, starts with a
 * move-to, draws at least one segment, and never closes a subpath twice in a row. "M0,0 Zzz" fails:
 * it draws nothing.
 */
export function isValidCutOutPath(path: string): boolean {
  const tokens = path
    .trim()
    .replace(/([MmLlHhVvZzCcSsQqTtAa])/g, " $1 ")
    .replace(/,/g, " ")
    .replace(/(\d)-/g, "$1 -")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0 || !/^[Mm]$/.test(tokens[0] as string)) return false;
  let i = 0;
  let drew = 0;
  let lastWasClose = false;
  while (i < tokens.length) {
    const cmd = (tokens[i] as string).toUpperCase();
    const arity = ARITY[cmd];
    if (arity === undefined || (tokens[i] as string).length !== 1) return false;
    i += 1;
    if (cmd === "Z") {
      if (lastWasClose) return false;
      lastWasClose = true;
      continue;
    }
    lastWasClose = false;
    // one or more argument groups follow; an implicit repeat of M is a line-to
    let groups = 0;
    while (i < tokens.length && NUMBER.test(tokens[i] as string)) {
      for (let k = 0; k < arity; k += 1, i += 1)
        if (i >= tokens.length || !NUMBER.test(tokens[i] as string)) return false;
      groups += 1;
    }
    if (groups === 0) return false;
    drew += cmd === "M" ? groups - 1 : groups;
  }
  return drew > 0;
}

/** The path the engine cuts with: null (rectangle) when absent or invalid. */
export function effectiveCutOutPath(path: string | null): string | null {
  return path !== null && isValidCutOutPath(path) ? path : null;
}
