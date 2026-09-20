# ADR-025: Compaction: what to drop when the conversation outgrows the window

Status: Proposed
Date: 2026-09-20
Related: ADR-007 D1 (provider, and the two wires), ADR-022 D8 (context is a
budget), ADR-024 (how the agent gets better)

## Context

Nothing compacts anything today. When the conversation outgrows the window the
server silently drops the front of the prompt, and the front is the system
prompt and the brief. The agent loses its instructions and the task first and
keeps the most recent tool noise, which is the worst thing it could keep. The
only thing that notices is a heuristic in the runner that warns, after the
fact, when the reported prompt size stops growing while the conversation does.

Before choosing a strategy, four things were measured on a real run: the
one-bedroom card against the 35B model this project is meant to run on, which
built a correct flat in twenty-six steps.

### The window is nearly half spent before anybody says anything

| Part of every single prompt | Tokens | Of a 32,768 window |
|---|---|---|
| 32 tool schemas, re-sent every step | 12,641 | 39% |
| system prompt | 2,997 | 9% |
| the brief | 17 | under 1% |
| **fixed total** | **15,655** | **48%** |

This is the fact that decides everything below. Compaction can only ever touch
the other half. It also means the biggest single saving available is not
compaction at all: the architect's six tools cost 2,595 tokens against 12,641
for the full set, so narrowing the tool surface saves four times what emptying
the entire conversation would. That is ADR-022 D8's first point and it stays
ahead of this one in the queue.

### The conversation is almost entirely tool results

Over those twenty-six steps:

| | Tokens | Share |
|---|---|---|
| 26 tool results | 10,046 | 87% |
| assistant text | 983 | 9% |
| 26 tool calls | 466 | 4% |

The fattest were `build_design` at 1,306 tokens and three `describe_room`
replies at about 880 each. The average result was 386 tokens, and results grew
the conversation by a median 545 tokens a step.

### Our results are not a coding agent's file reads

This is the asymmetry that makes a different strategy right here.

When a coding agent reads a file into context, that text is the only copy it
has; the file may change underneath it and the conversation is its record of
what it saw. Our tool results describe a project that is still there. A result
saying a wall was created is worthless the moment the wall exists, because
`get_scene` and `describe_room` will answer the same question from the store,
exactly, at any time. Cascade summarises with a model because its context holds
reasoning about code that is in no file. Ours holds 9% reasoning and 87%
restatements of a world we can re-read for nothing.

### What already limits growth

Worth saying, so this decision does not re-invent them: each result is cut at
16,000 characters; only the newest render survives, older images replaced by a
note; a sub-run gets a fresh context, so the architect's 31,530 tokens never
entered the parent conversation; and the stall and loop breakers keep their own
list of recent calls rather than reading the messages, so compaction cannot
blind them.

## The scenarios

Each was worked through against every candidate. The point of listing them is
that three of the eight rule out strategies that otherwise look fine.

**S1. One long build run.** Measured: 15,655 fixed plus 545 a step. Crosses a
32,768 window at about step 31 and fits easily in 65,536. This is the case
everyone designs for and it is not the hard one.

Amended 2026-09-20: the step budget is two hundred rather than forty, raised
once this decision was built. Forty was the number that kept a run inside a
window, not the number a job needs, and rationing steps to work around a
context problem was solving the wrong thing. It changes nothing above except to
make S1 a case that happens rather than a case that is imagined: at 32,768 a
long run now compacts roughly every seventeen steps instead of ending before it
compacts at all.

**S2. A chat that keeps going.** "Build a flat", then "now add a table", then
"make the bedroom bigger". The host stores the whole message array after a run
and replays all of it as history. Each run adds about 11,500 tokens, so the
second message starts near 27,000 and the third is over 32,768 before the model
has done anything. **This is the hard one, and it is the one the user asked
about.** Any strategy that only compacts inside a run fails here.

**S3. A decision made early and needed late.** The person said no separate
dining room in the first message; at step 30 the model must still know. Rules
out anything that drops the front, which is what the server does today.

**S4. An identifier from an old result.** `search_catalog` returned a product
id at step 8 and `place_item` needs it at step 20; `place_item` returned an
item id that `modify_item` needs later. Rules out dropping results wholesale
without keeping what they named.

**S5. Not repeating a failure.** A call failed at step 5 and must not be tried
again the same way. The breakers survive compaction by construction, but the
model only avoids the repeat if it can still see the failure. Argues for
keeping failures longer than successes.

**S6. A model with a small window.** An 8,192-token model cannot run this agent
at all: the low profile's 22 schemas are 8,608 tokens and the system prompt is
another 2,997. No compaction fixes that, because none of it is conversation.
The honest answer is to refuse at startup and say why, not to compact into a
window that was never big enough.

**S7. A plan read from an image.** A large attachment and repeated compare
cycles. Already handled by the render rule, and the attachment never enters the
conversation as bytes.

**S8. A question to the person, answered twenty minutes later.** The run parks
and the context is held as it was. No new problem, but it rules out compacting
on a timer rather than on a measurement.

## The strategies considered

**A. Nothing, which is today.** Fails S1, S2 and S3 in the worst way available:
the loss is silent and it takes the instructions first.

**B. Refuse and stop when the next prompt would not fit.** Honest and trivial.
Fails S1 and S2 as a product. Kept as the last resort behind everything else,
because a run that stops with a reason beats a run that quietly forgets its
task.

**C. Slide a window over the messages.** Drop the oldest until it fits. Fails
S3 and S4 for the same reason A does: the oldest messages are the brief and the
decisions. Becomes acceptable only once the front is pinned, at which point it
is a worse version of D.

**D. Turn old tool results into receipts.** Keep every user and assistant
message and every tool call. Replace the body of a result older than the
recency shield with one line that keeps what the result named — whether it
worked, what it changed — and says the detail was dropped and can be re-read.
Reclaims 87% of the conversation at a cost of about 30 tokens a receipt.
Answers S4 by keeping the identifiers, and S5 by keeping failures in full.

**E. Summarise with a model.** What a coding agent must do. Costs a model call,
which on this hardware is a hundred seconds and a fresh chance to lose a
detail, and it is aimed at the 9% of our conversation that is reasoning rather
than the 87% that is restatement. Not worthless, but not first.

**F. Narrow the tool surface.** Saves 10,046 tokens against 12,641 — more than
emptying the conversation entirely. Not compaction, and not in this decision,
but it belongs in the same sentence whenever anybody says the window is tight.

**G. Throw the conversation away and restate the world.** Replace everything
with the brief, the plan, and a fresh scene summary. Cheapest of all and the
most lossy: it answers S3 only if the brief is kept verbatim and fails S5
completely, because why something was not done is nowhere in the store.

## Decision

### D1. We do the cutting, never the server

A prompt is measured before it is sent. If it will not fit, something is
removed on purpose, by us, with a note in the conversation saying so. The
server silently dropping the front is treated as the bug it is, and the
existing warning heuristic stays as the detector of last resort.

Measured, not estimated by counting characters and hoping: the provider reports
the prompt size it actually used on every reply, and the wire we now speak to
Ollama reports it separately from generation. The estimate is only used for the
turn that has not happened yet, and it is corrected by what comes back.

### D2. Four layers, cheapest first, run all the way down

1. **Receipts for old tool results** (strategy D). Everything outside the
   recency shield becomes one line.
2. **Drop superseded results.** A second `describe_room` for the same room
   makes the first one worthless; the same is true of `get_scene` and
   `validate`. Only the newest of each survives, even inside the shield.
3. **Drop the receipts themselves**, oldest first, once every result outside
   the shield is already a receipt.
4. **Give up the shield itself**, oldest first, down to the last two.
5. **Refuse** (strategy B), with the reason and the suggestion to start a new
   chat, when a single step still will not fit.

Layer 4 was added after the first live run. On a 24,576-token window the fixed
cost was 16,436 and the reserve 2,048, leaving 6,092 for the conversation --
and eight results of the size that run produced are about 6,000. The shield was
the entire budget, layer 3 had nothing left to reach, and a run that was going
perfectly well stopped at step 21 holding a shield it could not afford. A
shield is a good idea, not an entitlement: where there is no room for eight
recent results there is room for two, and two is far better than stopping.

Layer 5 is reachable only when two results, every word the person said and the
tool calls that are never dropped still exceed the window. It is there so the
failure has a sentence rather than a silence.

The first version of this decision said "stop as soon as it fits". That was
wrong, and D2a is why.

### D2a. Compact late, and then compact all the way

Two rules, and they pull in the same direction.

**Trigger as late as is safe.** Compaction is not free: it rewrites the middle
of the message array, so the server's cached prefix survives only as far as the
first changed message. Everything after that is prefilled again. Measured on
this hardware, prefill runs at 301 tokens a second, so re-running a 5,000-token
conversation costs about eighteen seconds of staring at nothing. A conversation
that fits is never touched.

**Then go deep, but no deeper than is needed.** Once the prefix is broken the
cost is already paid, and stopping the moment the prompt fits means paying it
again on the very next step. This is not a small difference:

| Policy, on a 32,768 window | Compactions | Cost each |
|---|---|---|
| stop as soon as it fits | every step | ~48 s |
| run down to the floor | one every 17 steps | ~18 s |

But "as deep as possible" is wrong in the other direction, and the owner caught
that too. What is dropped is gone, and a model with more of the conversation in
front of it is working from more. So the target is the largest conversation
that still guarantees a set number of steps before the next compaction, and the
layers stop the moment they reach it, oldest results first.

**Thirty steps, and the unit is steps rather than a share of the window.** A
ratio cannot work, because the fixed cost is an absolute number: on a
16,384-token window the conversation budget is negative, and on 32,768 a target
of 40 per cent leaves under four steps of room. Thirty steps means the same
thing on every model, and on a 65,536-token window it is enough that an
ordinary run never compacts at all.

What that gives, with the measured 545 tokens a step:

| Window | Kept after compacting | Of the window | Steps until the next |
|---|---|---|---|
| 32,768 | about 5,000, the floor | 15% | 18 |
| 65,536 | 31,483 | 48% | 30 |
| 131,072 | 97,019 | 74% | 30 |
| 200,000 | never reached in 334 steps | | |

On a small window the target lands below what the layers can reach and they
simply do everything they can. On a large one most of the conversation is left
alone, which is the point.

**Keeping more is not free, and the trade is taken with eyes open.** What
survives is prefilled again, so a shallower cut costs longer. On this hardware,
on a 65,536-token window, keeping 31,483 tokens rather than cutting to 5,000
costs about five minutes more over a hundred steps. That is accepted: spent
seconds come back and dropped detail does not. It is a setting for anyone who
disagrees.

**The floor is a number, not a fraction, and this matters.** The fixed cost is
15,655 tokens whatever the window is, so the deepest possible compaction lands
at a different fraction on every model:

| Window | Compacts at | Down to | Of the window | Steps until the next one |
|---|---|---|---|---|
| 32,768 | step 27 | 21,034 | 64% | 17 |
| 65,536 | step 87 | 26,205 | 40% | 67 |
| 131,072 | never in a 40-step run | | | |

On a 32,768-token window 64% is not a choice. It is the floor, because 48% of
it cannot be removed. Anyone asking why compaction will not go to 50% on a
small model is really asking why the tool schemas are 12,641 tokens, and the
answer to that is ADR-022 D8, not this decision.

### D2b. The reply is part of the window, so it is reserved and clamped

The window holds the prompt and what the model generates, so a trigger that
looks only at the prompt is wrong twice over.

**Reserved:** the budget for the prompt is the window minus a reply reserve of
2,048 tokens. Measured, our replies ran between 40 and 219 tokens a step, and
the architect's longest was 766, so 2,048 is generous without being wasteful.

**Clamped:** the output cap sent with each request is lowered to what is
actually left, so a model allowed 8,000 tokens by configuration cannot generate
past the end of a window with 3,000 free. A configured cap is a ceiling, never
a promise of room.

### D3. What is never dropped, at any layer

- The system prompt and the tool schemas, which we could not drop anyway.
- **The person's own messages, verbatim, all of them.** They are 60 characters
  each and they are the task. This answers S3 outright.
- The current plan, which is pinned into the system prompt already.
- Every tool **call**, which is how the model knows what it has done; calls are
  4% of the conversation and dropping them buys nothing.
- **Failed results in full**, however old (S5). A failure is small, and it is
  the one kind of result that is not restating a world we can re-read.
- The last render, which the existing rule already handles.

### D4. The shield is eight results, from the measurement, and it sets the floor

Eight results at the measured 386-token average is about 3,100 tokens. A
forty-step stretch then costs roughly 3,100 for the shield and 1,000 for
thirty-two receipts, against 15,400 uncompacted — so a run that would have crossed a
32,768 window at step 31 instead finishes at about 21,000 tokens with room to
spare.

Eight rather than four because `describe_room`, `search_catalog` and
`place_item` commonly work in pairs across three or four steps, and eight
rather than sixteen because sixteen is half the compactible half. The number is
a setting, and the eval suite is what will move it.

### D5. Between runs, not only within them

S2 is the failure the user actually reported and it needs its own rule. When a
run ends, the stored conversation is compacted before it is stored, not when it
is next read: results outside the shield become receipts, and tool calls and
results from runs before the previous one are dropped entirely, leaving the
person's messages and the agent's final answers. A conversation that has been
going all afternoon is then a transcript of what was asked and what was said
back, which is what a person would remember of it too.

### D6. Re-reading is the recovery, and the model is told so

Every receipt ends with the same clause: the detail was dropped, and
`get_scene` or `describe_room` will give it back. This is the whole reason
receipts are safe here and would not be in a coding agent, so it is said in the
receipt rather than only in the system prompt, where it would be far away from
the moment it is needed.

### D7. No model-written summary yet, and the condition for it

Not built. It costs a call, it is aimed at the smallest part of the
conversation, and layers 1 to 3 are free. **Revisit when** the eval suite shows
a run failing after compaction that succeeded before it, and the lost thing is
a piece of reasoning rather than a fact that could have been re-read. Until
then a summary is an expensive answer to a question the measurements do not
ask.

### D8. A window too small to hold the prompt is refused at startup

S6 is not a compaction problem. When the fixed cost exceeds the model's window,
the agent says so when it starts and does not offer itself, naming the number
and the model. A tool that half works is worse than one that explains why it
cannot.

## Alternatives considered

**Cascade's five layers, as they are.** Rejected as a port, adopted as a shape.
The ordering idea is right and is D2. The layers themselves are built for a
coding agent: they know tool names like Read and Edit, they operate on an
Anthropic-style content-block model we do not have, and their expensive layer
is a model summary aimed at reasoning that makes up 9% of our conversation
rather than most of it. Taking them whole would mean porting a message model
and a provider shim to get a worse fit.

**Compact on a schedule, or every N steps.** Rejected by S8 and by taste: a
conversation that fits should not be touched, and the only honest trigger is a
measurement of the thing being managed.

**Compact early, at 70 or 80 per cent, to leave a margin.** Rejected on the
prefill numbers. An early trigger does not buy a margin, it buys more
compactions, and each one costs a re-prefill. The margin comes from the depth,
which D2a takes to the floor, not from the timing.

**Aim compaction at a percentage of the window.** Rejected: the fixed cost is
an absolute number, so the same percentage is easy on one model and impossible
on another. On a 32,768-token window a target of 50 per cent cannot be reached
at all, and on 16,384 there is no conversation budget to take a percentage of.
The idea behind it was right and is kept as the headroom target in D2a; only
the unit changed, from a share of the window to a number of steps.

**Always cut to the floor, whatever the window.** Rejected once the numbers
were done. It is the cheapest policy in prefill seconds and it throws away
detail nobody asked it to throw away: on a 131,072-token window it would keep
4 per cent of the conversation where 74 per cent would have done, and buy
headroom far past anything a run will use.

**Keep a summary and the detail.** Rejected: it grows the conversation to save
space in it.

**Compact only between runs.** Half the answer, and the half that does not help
S1. Kept as D5, not as the whole decision.

**Compact only within a run.** The other half, and it is the one that fails the
case the user actually hit. Both or neither.

**Let the person choose what to keep.** Rejected for now: nobody wants to
curate a transcript, and the measurements say the machine can decide this one
safely because the world is re-readable.

## Consequences

- A pure module that takes messages, a budget and the shield size and returns
  messages, tested against the shapes above rather than against a live model.
  No model call, no I/O, no new dependency.
- The runner measures before it sends and emits an event when it compacts, so
  the chat can say what happened rather than the conversation silently shifting
  under the person.
- The host compacts a conversation before storing it, which changes what a
  follow-up sees; the conversation file on disk becomes a record of the
  exchange rather than of every call.
- The receipt format is part of the prompt contract: the system prompt tells
  the model that old detail becomes a receipt and that re-reading is free.
- `contextTokens` stops being a number nothing reads. On Ollama it is already
  the context the model is loaded with; now it is also the budget.
- Nothing here helps a window smaller than the tool schemas, and D8 says so out
  loud instead of pretending.
