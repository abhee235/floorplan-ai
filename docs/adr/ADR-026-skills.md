# ADR-026: Skills: teaching the agent things it was not trained on

Status: Proposed
Date: 2026-09-20
Related: ADR-006 (tool tiers), ADR-007 (provider), ADR-022 (agent roles, D8 context
is a budget), spec 07 (rules packs)

## Context

A model asked to design an office for a hundred people produced sixteen rooms,
every one of them the same 11.2 m deep, several of them 1.1 m wide. A
four-person meeting room 1.1 m wide cannot hold a table. The owner asked the
obvious question: the model is not an architect, so where is it supposed to
have learnt this, and can we teach it?

The question is right and the first answer is not the obvious one.

### The model did not choose those dimensions

`packProgramme` did, in code, deterministically. The model writes a programme —
which rooms, roughly what area — and the packer turns it into rectangles. So
the failure is not ignorance in the model. It is this, in
`packages/catalog/src/rules/pack.ts`:

```
const MIN_SIDE = { bedroom: 2400, living: 3000, kitchen: 1800,
                   dining: 2400, bathroom: 1500, toilet: 900 };
```

Six entries, every one residential. A meeting room, a boardroom, a training
room, an open office, a cafeteria and a reception are all absent, so each fell
through to the width of a door wall, 1,000 mm.

### Knowledge we already have is in a place that cannot act on it

The system prompt says, today, "corridor 1500 wide". The packer has
`CORRIDOR_MM = 1150` and never reads the prompt. The hallway came out 1.1 m,
which for a hundred occupants is below the 1,118 mm that IBC 2024 section
1020.3 requires, so it is a failure rather than a preference.

**That is the fact this decision turns on.** A document the model reads cannot
fix a number the model never chooses. Cascade's skills work because its agent
does the work itself; ours hands the geometry to a program.

### What the field actually says, gathered rather than assumed

| Rule | Value |
|---|---|
| meeting room minimum width | 2,700 mm: a 900 table and 900 clear each side |
| meeting room area | 1.8–2.3 m² a seat; 3.7–4.2 for a boardroom |
| corridor, 50+ occupants | 1,118 mm minimum; 1,500–2,000 where it is also egress |
| clear behind a desk | 750 mm, or 1,500 with a walkway behind it |
| back-to-back desk clusters | 1,980–2,440 mm, desk edge to desk edge |
| toilets for 100 staff | 5 WCs and 5 basins |

None of that is in the packer. Most of it is not anywhere.

### Three places knowledge could live, and what each can do

1. **The system prompt.** Reaches the model on every step, costs 2,997 tokens
   before anything is added, and cannot influence the packer.
2. **The rules pack** (spec 07). Versioned, schema-checked, extendable,
   reaches tools as `ctx.rules`, already holds named numbers, design rules and
   room recipes. The checker reads it. The packer does not, and the model never
   sees it.
3. **Nothing else.** There is no skills mechanism of any kind.

## Decision

### D1. A skill is two things, and they go to different readers

Not one mechanism. The split is forced by the fact above.

- **Numbers go to the rules pack**, which already exists and already travels to
  the tools. Minimum widths, minimum areas per seat, corridor widths, clearances
  and required rooms are facts, and the packer and the checker are what obey
  them.
- **Judgement goes to a skill document**, which the model reads. Which rooms a
  brief implies, what should be next to what, how a floor is zoned, what to ask
  about. This is the part a model can act on and a table of numbers cannot
  express.

A skill may name the rules pack it needs, so the two travel together and a
person installing "offices" or "healthcare" gets both halves at once.

### D2. The packer reads its dimensions rather than holding them

`MIN_SIDE`, `MIN_M2`, `DEFAULT_M2`, `MAX_M2`, `CORRIDOR_MM` and `DOOR_WALL_MM`
stop being constants in the file and become lookups with the constants as the
fallback. A rules pack that says nothing changes nothing.

This is most of the fix and it is not a new feature. It is the difference
between knowledge the product has and knowledge the product can use.

**And the missing workplace rows are added**, because the immediate bug is that
they are absent, not that they are hard-coded.

### D3. Skills are indexed in the prompt and loaded by a tool

Cascade's shape, for its reasons, which hold here too.

- A skill is `<dir>/<name>/SKILL.md` with `name`, `description` and `whenToUse`
  in its frontmatter, plus optional reference documents beside it.
- Only the three frontmatter fields reach the system prompt, one line each.
  Bodies are never inlined. At 2,997 tokens of prompt on every step against a
  32,768-token window, a pack of ten skills inlined would be most of what is
  left after the tool schemas.
- A `read_skill` tool returns the body, or a named reference file. Unknown
  names answer with the list of real ones, so a wrong guess costs one step and
  corrects itself.
- Directories are ordered and a later one shadows an earlier one by name:
  built-in, then the machine's, then the project's.
- A skill that will not parse is skipped rather than fatal. Nothing about a
  document should be able to stop a session starting.

### D4. Skills are advice; rules packs and the checker are not

A skill cannot change what the checker accepts, cannot grant a tool, and cannot
relax a rule. It is read by a model that is still answerable to `checkLayout`
and `validate` afterwards. This is the same line ADR-024 D1 draws for the
verifier, and for the same reason: the agent's claim on anybody's trust is that
something which cannot be talked round has measured its work.

A pack, by contrast, **is** authority — it is what the checker checks against —
which is why a pack is schema-validated, versioned and extends another by id,
and a skill is a document that can say anything.

### D5. What ships with the product

Two skills, written from the sources gathered above, with the numbers in a
matching pack: **office layout** and **home layout**. Each says how a floor is
zoned, what a brief of that kind implies, the adjacencies that matter, and what
to ask when the brief does not say.

They ship as built-ins rather than examples, because a product whose out-of-the
box answer is a 1.1 m meeting room has not shipped the knowledge it needs.

## Alternatives considered

**Put the numbers in the prompt and let the model apply them.** Rejected on the
evidence in the context: the prompt already says 1,500 for a corridor and the
building came out with 1,100. The model does not place the rectangles.

**Put everything in the prompt, skills included.** Rejected on cost. The prompt
is re-sent on every step and is already 9 per cent of a small window; a pack of
skills inlined would rival the tool schemas, which are already 39 per cent.

**Make skills executable — let a skill carry code the packer runs.** Rejected.
It turns a document anybody can write into a program anybody can run inside the
one part of the system that is deterministic. The rules pack is the supported
way to change what the geometry does, and it is schema-checked for exactly this
reason.

**A matcher that injects the right skill automatically.** Deferred. It is
cheaper for the model and it hides why a skill appeared, which makes a bad
answer harder to explain. An explicit call is the most reliable thing a weak
model does and it shows up in the trace. Revisit if the eval suite shows models
failing to load a skill they needed.

**Lift cascade's engine unchanged.** Taken, for the half that fits. Its loader
is about 170 lines, depends only on the filesystem, path and zod, and never
touches its own tool context, so it ports with a small adapter. Its session
wiring, its packaging story and its slash-command surface do not, and are
rewritten rather than copied.

**Skip skills, just fix the packer.** Tempting, and it would fix this bug. It
would not answer the question underneath it, which is that every new building
type needs knowledge the model does not have and no one can add without a
release.

## Consequences

- `packages/catalog/src/rules/pack.ts` takes its dimensions from the pack, with
  today's constants as the fallback, and gains workplace rows.
- A new `packages/agents/src/skills.ts`: load, index, and a `read_skill` tool.
  Pure over a list of directories; no storage, no protocol, no UI state.
- `designerSystem` gains a skills index section, one line per skill, and the
  architect's prompt says to read the skill for the kind of building it is
  designing before writing a programme.
- Skill directories: built-ins beside the host, `<data>/skills`, and
  `<project>/.fpv/skills`, in that order of precedence.
- The eval cards gain a case per built-in skill, because a skill nobody
  measures is a document nobody can tell is working.
- What this deliberately leaves out, so a later reader knows it was considered:
  automatic matching, per-skill tool grants, skills that carry code, and skills
  delivered over MCP.
