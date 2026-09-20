# ADR-024: How the agent gets better: a score, best of several, and a suite that measures it

Status: Proposed
Date: 2026-09-20
Related: ADR-007 (provider and runner), ADR-022 (agent roles and the checker),
ADR-023 (authorship and consent), spec 04 (tools), docs/eval/agent-runs.md

## Context

Three runs of one brief, "build a 3 bedroom apartment with hall and lobby",
against the same model, with nothing changed between them but our own code:

| | first | after the prompt | after the architect and packer |
|---|---|---|---|
| rooms | 5 | 9 | 9 |
| walls around nothing | 24 | 0 | 0 |
| rooms with a bare side | not measured | 5 | 0 |
| items across a door or window | 12 | 12 | 1 |
| steps | 40, the budget | 25 | 10 |
| prompt tokens | ~760,000 | 419,915 | 157,739 |

Every one of those gains came from moving work out of the model and into code:
the room vocabulary, the size rules, the placement into free runs of wall, the
checker, the packer. None came from a better model, a longer prompt or more
turns. That is the trend this decision is about, and the question it answers is
what to do next: keep going, or reach for reinforcement learning and a harness
that rewrites itself.

### What the field says, checked rather than assumed

**Reinforcement learning with verifiable rewards, on this exact problem.** Lara
et al. (ACL 2026 Findings) fine-tuned Llama-3.3-70B on 80,788 RPLAN floor plans
with LoRA across six nodes of four H100s, then ran GRPO with a reward of
connectivity by graph edit distance plus total-area deviation, and zero for an
overlapping or malformed plan. At eight rooms their overlaps per plan went
0.51 few-shot, 0.37 after fine-tuning, 0.13 after RLVR, with best-of-ten
sampling at inference. They list as limitations that they check no egress, no
accessibility, no structural constraint and no building code, and that expert
review remains essential.

Our packer produces nine rooms with zero overlaps by construction, at no
training cost, deterministically, and our checker does test a route from the
front door. On the metric they optimised we are already past the result they
trained for, because a constraint that can be constructed does not need to be
learned.

**Self-evolving harnesses.** Self-Harness (arXiv 2606.09498) mines failures
from traces, proposes harness edits and accepts them after regression testing.
Two findings temper it. "Harness Updating Is Not Harness Benefit" (arXiv
2605.30621) reports that an updated harness does not automatically improve
anything and that the ability to *benefit* from one is non-monotonic in model
size. Weng's survey notes that recursive self-improvement helped GPT-4 and
*degraded* GPT-3.5 and Mixtral: the base model has to be strong enough to
improve the mechanism. The safety survey (arXiv 2606.23075) lists reward
hacking and capability drift as the primary threats, amplified across
iterations. Notably, Agentic Harness Engineering keeps its verifiers read-only
and outside the editable system for exactly that reason.

## Decision

### D1. The verifier is code, and a person writes it

`checkLayout`, `validate` and the packer are authored by people and changed by
people. No model edits them, proposes edits to them, or has them in its context
as something to work around.

This is not caution for its own sake. The agent's claim on anybody's trust is
that something which cannot be talked round has measured its work (ADR-022 D5).
A verifier the agent can rewrite is an opinion with extra steps, and every
serious treatment of self-evolving harnesses reaches the same conclusion from
the reward-hacking side.

### D2. No reinforcement learning, and the condition for revisiting

Not now, and the reason is not cost. It is that RL would be aimed at the wrong
half of the problem.

Geometry is constructible: rooms that do not overlap, doors with a wall to sit
in, a route from the entrance. We construct those, exactly, in `packProgramme`.
Training a model to approximate them is paying for 0.13 overlaps where code
gives 0.

What is *not* constructible is judgement: which rooms a brief implies, what
sizes suit a household, what a person meant by "hall". That is where RL could
help, and it is also where we use a hosted frontier model that cannot be
fine-tuned. Adopting RLVR means adopting an open model we can train, which
trades away the judgement we actually rely on.

**Revisit when** the eval suite (D5) shows that designs passing the checker are
still judged bad by people, *and* the failures are in the programme rather than
the geometry. Until both hold, RL is the answer to a question we do not have.

### D3. No self-evolving harness yet, and what would have to be true first

The mechanism is real and the direction is right; the preconditions are absent.

- **There is no regression suite.** Weakness mining and proposal validation
  both require one, and without it "the harness improved" is an unfalsifiable
  claim. This is the first thing to build, and D5 builds it.
- **The evidence is that it may not help.** An updated harness is not a better
  one, and the capacity to benefit is uneven.
- **We are not short of human-authored improvements.** Every failure in the
  last three runs had an obvious fix a person could write in an hour. A machine
  that writes fixes is worth having when the queue of obvious fixes is empty.

The half of Self-Harness worth taking now is the half that is not automatic:
mine the failures, and put them in a report somebody reads.

### D4. The checker returns a score, not only a verdict

`checkLayout` gains a scalar in [0, 1]: one minus a weighted penalty over the
problems it found, errors weighing far more than warnings, saturating so that a
hopeless design and a slightly worse hopeless design are not distinguished for
no reason.

Three things need it and none of them is RL. Best of several (D5) has to rank.
A regression suite has to say "worse than last week" rather than "still
failing". And a run's own summary can say how good the plan is rather than only
that it passed.

The score is derived from the problems, never stored, and never the thing a
model is given instead of the problems: a list of what is wrong is more use to
something trying to fix it than a number is.

### D5. Best of several, chosen by the checker

The one idea from the RLVR paper we can have for nothing. They sample ten plans
and keep the best; we can do the same without training, because packing and
checking are free.

The architect proposes up to three programmes in one answer rather than one.
Each is packed and checked. The best-scoring is what comes back, with the others
discarded and a note saying how many were tried and what separated them.

It costs one model call's worth of extra output and no extra tool calls, which
is why it is worth doing before anything cleverer. If it does not measurably
help, it comes out again, and the suite below is what decides.

### D6. A regression suite of briefs, with the checker as the judge

`tools/eval/cards/design/*.json`: a brief, the kind of building, and what the
checker must say about the result — no errors, every purpose present, a route
from the door, a score floor. Run per model, recorded in
`docs/eval/design-runs.md` beside the run notes we keep by hand.

This is the thing everything else waits on. It turns "the prompt feels better"
into a number, it is the regression test for the packer and the checker
themselves, and it is the precondition for any later harness evolution or RL.
It is also the cheapest item here.

## Alternatives considered

**Do RLVR now, because the paper is about our exact problem.** Rejected on
their own numbers: 0.13 overlaps after training against 0 by construction, and
their limitations list is the set of checks we already have. The paper's real
lesson is which half of the problem to hand to a model, and we had it the wrong
way round until this week.

**Fine-tune a small open model on our own runs.** Cheaper than RLVR and still
premature: we have three runs of one brief, not a dataset, and the model is not
currently the limiting factor. The suite in D5 would tell us if that changed.

**A vector database of past failures, retrieved as few-shot examples.**
Deferred. It is a reasonable idea and the cost is real: an embedding store, a
retrieval step in a latency-sensitive loop, and a new way for the prompt to
vary between runs, which makes every other measurement noisier. Our failures
are already structured — the checker emits codes — so if this is wanted, a
table keyed by problem code comes first and an embedding only if that is not
enough. And the packer removed most of the failures it would have retrieved.

**A critic model that writes new validators.** Rejected, permanently, for D1's
reason.

**A critic model that comments on designs without writing code.** Already
deferred in ADR-022 D3, and the reasoning is unchanged: measure what passes the
checker first, and add a critic only if people still dislike the results.

**Leave the checker as pass or fail.** Rejected: it blocks D5, and it makes
every future comparison qualitative.

## Consequences

- `checkLayout` returns `score` beside `problems` and `totals`;
  `layoutIsBuildable` is unchanged. Tests pin the score of the sound flat in
  the checker's fixture, and that breaking a room lowers it.
- `plan_rooms` takes an optional list of programmes rather than one, packs and
  checks each, and returns the best with `tried` and `rejected` counts. One
  programme stays the ordinary case.
- The architect's prompt asks for two or three programmes that differ in a way
  it can name, not three spellings of one.
- New eval cards and `docs/eval/design-runs.md`. The suite runs against the
  configured model, so it costs real calls; it is run on purpose, not in
  `pnpm check`.
- Nothing here needs a new package, a new process, a training run or a GPU.
- What this ADR deliberately leaves out, so a later reader knows it was
  considered and not forgotten: RL, harness self-editing, embedding memory and
  a model-authored critic, each with the condition that would bring it back.
