// Skills: what the model reads before it designs a kind of building (ADR-026 D3, ADR-027 D1).
//
// A skill is a document, `<dir>/<name>/SKILL.md`, with `name`, `description` and `whenToUse` in a
// leading `---` block. Only those three lines reach the system prompt, one line per skill; the body
// costs tokens only when the model asks for it with read_skill. Directories are read in order and a
// later one shadows an earlier one by name, so the machine's skills override the built-ins and a
// project's override both. A skill that will not parse is skipped, never fatal: no document should be
// able to stop a session starting.
//
// The shape is Cascade's, the owner's own agent, taken with leave; the loader is rewritten here.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { READ_SKILL } from "./loop-tools.js";
import type { ToolSpec } from "./provider.js";

export interface Skill {
  name: string;
  description: string;
  whenToUse: string | null;
  body: string;
  /** The file it came from, so a message about a bad skill can say where it lives. */
  source: string;
  /** Reference documents beside it, by path relative to the skill's directory. */
  references: Record<string, string>;
}

/** The three lines a skill contributes to the prompt. */
export type SkillIndexEntry = Pick<Skill, "name" | "description" | "whenToUse">;

/** A leading `---` block of `key: value` lines. Flat strings only: a skill file must never need YAML. */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of (m[1] as string).split("\n")) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (kv) meta[(kv[1] as string).toLowerCase()] = (kv[2] as string).trim();
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

function parseSkill(dir: string, fallbackName: string): Skill | null {
  const file = join(dir, "SKILL.md");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  const name = (meta.name || fallbackName).trim();
  if (!name || !body) return null;
  const references: Record<string, string> = {};
  const walk = (at: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const abs = join(at, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && /\.md$/i.test(e.name) && abs !== file)
        references[relative(dir, abs).replaceAll("\\", "/")] = abs;
    }
  };
  try {
    walk(dir);
  } catch {
    // a reference directory that cannot be read leaves the skill with its body alone
  }
  return {
    name,
    description:
      (meta.description ?? "").trim() ||
      body
        .split("\n")
        .find((l) => l.trim())
        ?.replace(/^#+\s*/, "")
        .slice(0, 160) ||
      name,
    whenToUse: (meta.whentouse ?? meta.when_to_use ?? "").trim() || null,
    body,
    source: file,
    references,
  };
}

/**
 * Every skill under the directories given, in order; a later directory's skill replaces an earlier
 * one of the same name. A directory that does not exist is the normal case and is skipped.
 */
export function loadSkills(dirs: readonly string[]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((e) => {
        try {
          return statSync(join(dir, e)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }
    for (const e of entries.sort()) {
      const skill = parseSkill(join(dir, e), e);
      if (skill) byName.set(skill.name.toLowerCase(), skill);
    }
  }
  return [...byName.values()];
}

/** One line per skill, for the prompt: the name, what it is, and when to read it. */
export function skillsIndex(skills: readonly SkillIndexEntry[]): string[] {
  return skills.map((s) => `  ${s.name}: ${s.description}${s.whenToUse ? ` Read it ${s.whenToUse}.` : ""}`);
}

export const READ_SKILL_SPEC: ToolSpec = {
  name: READ_SKILL,
  description:
    "Read one of the skills listed in your instructions: what somebody who does this for a living knows about a kind of building, in a page. Read the one for the building you are about to design before you call design_layout, and put what matters for this brief into notes. A name that does not exist answers with the names that do.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "the skill's name, as listed" },
      file: {
        type: "string",
        description:
          "a reference document inside the skill, as its body lists them; leave out for the skill itself",
      },
    },
    required: ["name"],
  },
};

type Envelope =
  | { ok: true; result: unknown; warnings: string[] }
  | {
      ok: false;
      error: { code: string; message: string; entityId: null; hint: string | null };
      warnings: string[];
    };

/** Answer a read_skill call from the loaded set; a wrong name costs one step and corrects itself. */
export function readSkill(skills: readonly Skill[], raw: unknown): Envelope {
  const a = (raw ?? {}) as { name?: unknown; file?: unknown };
  const name = typeof a.name === "string" ? a.name.trim().toLowerCase() : "";
  const names = skills.map((s) => s.name).join(", ");
  const skill = skills.find((s) => s.name.toLowerCase() === name);
  if (!skill)
    return {
      ok: false,
      error: {
        code: "skill.unknown",
        message: name ? `no skill named "${a.name as string}"` : "name is required",
        entityId: null,
        hint: names ? `the skills are: ${names}` : "there are no skills in this session",
      },
      warnings: [],
    };
  const refs = Object.keys(skill.references);
  if (typeof a.file === "string" && a.file.trim()) {
    const key = a.file.trim().replaceAll("\\", "/");
    const found = refs.find((r) => r.toLowerCase() === key.toLowerCase());
    if (!found)
      return {
        ok: false,
        error: {
          code: "skill.no-reference",
          message: `${skill.name} has no reference "${key}"`,
          entityId: null,
          hint: refs.length
            ? `its references are: ${refs.join(", ")}`
            : "it has no reference documents; read it without file",
        },
        warnings: [],
      };
    try {
      return {
        ok: true,
        result: {
          name: skill.name,
          file: found,
          text: readFileSync(skill.references[found] as string, "utf8"),
        },
        warnings: [],
      };
    } catch {
      return {
        ok: false,
        error: {
          code: "skill.unreadable",
          message: `${found} could not be read`,
          entityId: null,
          hint: null,
        },
        warnings: [],
      };
    }
  }
  return {
    ok: true,
    result: { name: skill.name, text: skill.body, references: refs },
    warnings: [],
  };
}
