// Score a project built from a picture against a reference built from the same picture.
// Usage: tsx tools/eval/score-fidelity.ts <built project.json> <reference project.json>
import { readFileSync } from "node:fs";
import { fidelityOverall, scoreFidelity } from "./fidelity.js";

const [builtPath, referencePath] = process.argv.slice(2);
if (!builtPath || !referencePath) {
  console.error("usage: tsx tools/eval/score-fidelity.ts <built project.json> <reference project.json>");
  process.exit(2);
}
const built = JSON.parse(readFileSync(builtPath, "utf8"));
const reference = JSON.parse(readFileSync(referencePath, "utf8"));
const score = scoreFidelity(built, reference);
console.log(JSON.stringify({ overall: fidelityOverall(score), ...score }, null, 2));
