// The rules expression language (spec 07 section 2): small, total and side-effect free, parsed and
// evaluated by our own code. Arithmetic and conditions share one grammar so `if(cond, a, b)` and
// `when` clauses need no second parser. No JavaScript is ever evaluated.

export type Scalar = number | string | boolean;
/** A value: scalars, lists (stock lengths) and opaque handles (an item for `distance(from, to)`). */
export type Value = Scalar | readonly number[] | Handle;

export class Handle {
  constructor(
    readonly kind: string,
    readonly ref: unknown,
  ) {}
}

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "id"; name: string }
  | { t: "call"; name: string; args: Node[] }
  | { t: "neg"; e: Node }
  | { t: "not"; e: Node }
  | { t: "bin"; op: "+" | "-" | "*" | "/"; a: Node; b: Node }
  | { t: "cmp"; op: "<" | "<=" | "==" | "!=" | ">=" | ">"; a: Node; b: Node }
  | { t: "logic"; op: "and" | "or"; a: Node; b: Node }
  | { t: "in"; e: Node; list: Node[] };

type Token =
  | { k: "num"; v: number; at: number }
  | { k: "str"; v: string; at: number }
  | { k: "id"; v: string; at: number }
  | { k: "op"; v: string; at: number }
  | { k: "end"; at: number };

const KEYWORDS = new Set(["and", "or", "not", "in", "true", "false"]);

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError(`unexpected "${c}" at ${i}`);
      out.push({ k: "num", v: Number(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExprError(`unterminated string at ${i}`);
      out.push({ k: "str", v: src.slice(i + 1, end), at: i });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i)) as RegExpExecArray;
      out.push({ k: "id", v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "==", "!="].includes(two)) {
      out.push({ k: "op", v: two, at: i });
      i += 2;
      continue;
    }
    if ("+-*/(),<>".includes(c)) {
      out.push({ k: "op", v: c, at: i });
      i += 1;
      continue;
    }
    throw new ExprError(`unexpected "${c}" at ${i}`);
  }
  out.push({ k: "end", at: src.length });
  return out;
}

class Parser {
  private i = 0;
  constructor(
    private readonly toks: Token[],
    private readonly src: string,
  ) {}

  private peek(): Token {
    return this.toks[this.i] as Token;
  }
  private next(): Token {
    const t = this.peek();
    this.i += 1;
    return t;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.k === "op" && t.v === v;
  }
  private isWord(v: string): boolean {
    const t = this.peek();
    return t.k === "id" && t.v === v;
  }
  private expect(v: string): void {
    if (!this.isOp(v)) throw new ExprError(`expected "${v}" at ${this.peek().at} in "${this.src}"`);
    this.i += 1;
  }

  parse(): Node {
    const n = this.or();
    if (this.peek().k !== "end")
      throw new ExprError(`unexpected input at ${this.peek().at} in "${this.src}"`);
    return n;
  }

  private or(): Node {
    let a = this.and();
    while (this.isWord("or")) {
      this.next();
      a = { t: "logic", op: "or", a, b: this.and() };
    }
    return a;
  }
  private and(): Node {
    let a = this.not();
    while (this.isWord("and")) {
      this.next();
      a = { t: "logic", op: "and", a, b: this.not() };
    }
    return a;
  }
  private not(): Node {
    if (this.isWord("not")) {
      this.next();
      return { t: "not", e: this.not() };
    }
    return this.cmp();
  }
  private cmp(): Node {
    const a = this.add();
    const t = this.peek();
    if (t.k === "op" && ["<", "<=", "==", "!=", ">=", ">"].includes(t.v)) {
      this.next();
      return { t: "cmp", op: t.v as "<", a, b: this.add() };
    }
    if (this.isWord("in")) {
      this.next();
      this.expect("(");
      const list: Node[] = [this.add()];
      while (this.isOp(",")) {
        this.next();
        list.push(this.add());
      }
      this.expect(")");
      return { t: "in", e: a, list };
    }
    return a;
  }
  private add(): Node {
    let a = this.mul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next() as { v: "+" | "-" };
      a = { t: "bin", op: op.v, a, b: this.mul() };
    }
    return a;
  }
  private mul(): Node {
    let a = this.unary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = this.next() as { v: "*" | "/" };
      a = { t: "bin", op: op.v, a, b: this.unary() };
    }
    return a;
  }
  private unary(): Node {
    if (this.isOp("-")) {
      this.next();
      return { t: "neg", e: this.unary() };
    }
    return this.atom();
  }
  private atom(): Node {
    const t = this.next();
    if (t.k === "num") return { t: "num", v: t.v };
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.k === "op" && t.v === "(") {
      const e = this.or();
      this.expect(")");
      return e;
    }
    if (t.k === "id") {
      if (t.v === "true" || t.v === "false") return { t: "bool", v: t.v === "true" };
      if (KEYWORDS.has(t.v)) throw new ExprError(`unexpected "${t.v}" at ${t.at} in "${this.src}"`);
      if (this.isOp("(")) {
        this.next();
        const args: Node[] = [];
        if (!this.isOp(")")) {
          args.push(this.or());
          while (this.isOp(",")) {
            this.next();
            args.push(this.or());
          }
        }
        this.expect(")");
        return { t: "call", name: t.v, args };
      }
      return { t: "id", name: t.v };
    }
    throw new ExprError(`unexpected end of expression in "${this.src}"`);
  }
}

const cache = new Map<string, Node>();

export function parse(src: string): Node {
  const hit = cache.get(src);
  if (hit) return hit;
  const node = new Parser(tokenize(src), src).parse();
  if (cache.size > 2000) cache.clear();
  cache.set(src, node);
  return node;
}

/** What identifiers and functions mean where an expression is evaluated. */
export interface Scope {
  ident(name: string): Value;
  call(name: string, args: Value[]): Value;
}

export function num(v: Value, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ExprError(`${what} is not a number`);
  return v;
}

export function str(v: Value, what: string): string {
  if (typeof v !== "string") throw new ExprError(`${what} is not a text`);
  return v;
}

function truthy(v: Value, what: string): boolean {
  if (typeof v !== "boolean") throw new ExprError(`${what} is not a condition`);
  return v;
}

function equal(a: Value, b: Value): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  return a === b;
}

function show(n: Node): string {
  switch (n.t) {
    case "num":
      return String(n.v);
    case "str":
      return `'${n.v}'`;
    case "bool":
      return String(n.v);
    case "id":
      return n.name;
    case "call":
      return `${n.name}(…)`;
    default:
      return "expression";
  }
}

/** Functions every scope has: arithmetic helpers, rounding, lists and the lazy `if`. */
function builtin(name: string, args: Value[]): Value | undefined {
  const n = (i: number) => num(args[i] as Value, `${name} argument ${i + 1}`);
  const arity = (k: number) => {
    if (args.length !== k) throw new ExprError(`${name} takes ${k} argument${k === 1 ? "" : "s"}`);
  };
  switch (name) {
    case "ceil":
      arity(1);
      return Math.ceil(n(0) - 1e-9);
    case "floor":
      arity(1);
      return Math.floor(n(0) + 1e-9);
    case "round":
      arity(1);
      return Math.round(n(0));
    case "abs":
      arity(1);
      return Math.abs(n(0));
    case "max":
    case "min": {
      // The core pack's display steps have said max(75, ...) since they were written, and every
      // one fell back to a fixed diagonal with a warning nobody read.
      // The design rules' scope has its own max: max('display', 'diagonalIn') is the largest such
      // spec among a room's items. Numbers are the arithmetic one; anything else is the scope's.
      if (args.length < 1 || !args.every((a) => typeof a === "number")) return undefined;
      const values = args.map((_, i) => n(i));
      return name === "max" ? Math.max(...values) : Math.min(...values);
    }
    case "sqrt":
      arity(1);
      if (n(0) < 0) throw new ExprError("sqrt of a negative number");
      return Math.sqrt(n(0));
    case "tan":
      arity(1);
      return Math.tan((n(0) * Math.PI) / 180);
    case "clamp":
      arity(3);
      return Math.min(Math.max(n(0), n(1)), n(2));
    case "roundUpTo": {
      arity(2);
      if (n(1) <= 0) throw new ExprError("roundUpTo needs a positive step");
      return Math.ceil(n(0) / n(1) - 1e-9) * n(1);
    }
    case "roundUpToAny": {
      arity(2);
      const list = args[1];
      if (!Array.isArray(list) || list.length === 0)
        throw new ExprError("roundUpToAny needs a list of values");
      const sorted = [...(list as number[])].sort((a, b) => a - b);
      const hit = sorted.find((v) => v >= n(0) - 1e-9);
      if (hit === undefined)
        throw new ExprError(`${Math.round(n(0))} is longer than the longest value ${sorted.at(-1)}`);
      return hit;
    }
    case "has": {
      arity(2);
      const [list, value] = args as [Value, Value];
      const items = Array.isArray(list)
        ? (list as number[]).map(String)
        : typeof list === "string"
          ? list.split(/\s*[,;|]\s*/)
          : null;
      if (!items) throw new ExprError("has needs a list or a comma-separated text");
      const want = String(value).replace(/\s+/g, "").toLowerCase();
      return items.some((x) => x.replace(/\s+/g, "").toLowerCase() === want);
    }
    default:
      return undefined;
  }
}

export function evaluate(node: Node, scope: Scope): Value {
  switch (node.t) {
    case "num":
    case "str":
    case "bool":
      return node.v;
    case "id":
      return scope.ident(node.name);
    case "neg":
      return -num(evaluate(node.e, scope), show(node.e));
    case "not":
      return !truthy(evaluate(node.e, scope), show(node.e));
    case "bin": {
      const a = num(evaluate(node.a, scope), show(node.a));
      const b = num(evaluate(node.b, scope), show(node.b));
      if (node.op === "+") return a + b;
      if (node.op === "-") return a - b;
      if (node.op === "*") return a * b;
      if (b === 0) throw new ExprError(`division by zero: ${show(node.b)} is 0`);
      return a / b;
    }
    case "cmp": {
      const a = evaluate(node.a, scope);
      const b = evaluate(node.b, scope);
      if (node.op === "==") return equal(a, b);
      if (node.op === "!=") return !equal(a, b);
      const x = num(a, show(node.a));
      const y = num(b, show(node.b));
      if (node.op === "<") return x < y - 1e-9;
      if (node.op === "<=") return x <= y + 1e-9;
      if (node.op === ">") return x > y + 1e-9;
      return x >= y - 1e-9;
    }
    case "logic": {
      const a = truthy(evaluate(node.a, scope), show(node.a));
      if (node.op === "and" && !a) return false;
      if (node.op === "or" && a) return true;
      return truthy(evaluate(node.b, scope), show(node.b));
    }
    case "in": {
      const v = evaluate(node.e, scope);
      return node.list.some((x) => equal(v, evaluate(x, scope)));
    }
    case "call": {
      if (node.name === "if") {
        if (node.args.length !== 3) throw new ExprError("if takes 3 arguments");
        const c = truthy(evaluate(node.args[0] as Node, scope), "if condition");
        return evaluate((c ? node.args[1] : node.args[2]) as Node, scope);
      }
      const args = node.args.map((a) => evaluate(a, scope));
      const b = builtin(node.name, args);
      if (b !== undefined) return b;
      return scope.call(node.name, args);
    }
  }
}

export type EvalResult<T> = { ok: true; value: T } | { ok: false; error: string };

function run<T>(src: string, scope: Scope, check: (v: Value) => T): EvalResult<T> {
  try {
    return { ok: true, value: check(evaluate(parse(src), scope)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A number, or the reason it could not be computed; never throws. */
export function evalNumber(src: string, scope: Scope): EvalResult<number> {
  return run(src, scope, (v) => num(v, `"${src}"`));
}

/** A condition, or the reason it could not be computed; never throws. */
export function evalCondition(src: string, scope: Scope): EvalResult<boolean> {
  return run(src, scope, (v) => truthy(v, `"${src}"`));
}

/** Throws ExprError when the text does not parse; for pack validation. */
export function checkSyntax(src: string): void {
  parse(src);
}
