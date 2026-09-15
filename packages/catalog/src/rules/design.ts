// Design rules (spec 07 section 4): per-room conditions reported as `design.<rule id>` problems, in the
// same shape as IR validation so `validate` and every mutating tool result can carry them.
import type { Problem, Project } from "@fpv/ir";
import { evalCondition } from "./expr.js";
import { type BomCatalog, makeScope, ProjectFacts } from "./facts.js";
import type { RulesPack } from "./schema.js";

export function checkDesign(
  project: Project,
  pack: RulesPack,
  options: { catalog?: BomCatalog | null } = {},
): Problem[] {
  const rules = pack.designRules.filter((r) => r.enabled);
  if (rules.length === 0 || project.rooms.length === 0) return [];
  const facts = new ProjectFacts(project, options.catalog ?? null);
  const out: Problem[] = [];
  for (const room of facts.rooms) {
    const items = facts.inRoom(room);
    const scope = makeScope({
      facts,
      items,
      room,
      level: facts.levelOf(room.levelId),
      packFacts: pack.facts,
    });
    for (const rule of rules) {
      const applies = evalCondition(rule.applies, scope);
      if (!applies.ok) {
        out.push({
          code: "design.rule-error",
          severity: "warning",
          entityId: room.id,
          message: `design rule ${rule.id} could not be checked: ${applies.error}`,
          hint: null,
          related: [],
        });
        continue;
      }
      if (!applies.value) continue;
      const check = evalCondition(rule.check, scope);
      if (!check.ok) {
        out.push({
          code: "design.rule-error",
          severity: "warning",
          entityId: room.id,
          message: `design rule ${rule.id} could not be checked: ${check.error}`,
          hint: null,
          related: [],
        });
        continue;
      }
      if (check.value) continue;
      out.push({
        code: `design.${rule.id}`,
        severity: rule.severity,
        entityId: room.id,
        message: `${room.name ?? room.id}: ${rule.message}`,
        hint: rule.hint,
        related: items.map((f) => f.item.id),
      });
    }
  }
  return out;
}
