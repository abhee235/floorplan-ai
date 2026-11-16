# ADR-031: Context management is Cascade's, ported

Status: Proposed
Date: 2026-09-24
Supersedes: ADR-025 D1 to D4 and D8 (the in-run layers, the shield, the budget and the refusal at start).
ADR-025 D5 (what a finished run leaves for the next) and D6 (re-reading is the recovery) stay.
Related: ADR-029 (the neutral conversation this works on), ADR-030 (run_code, whose scripts are the
largest tool inputs we have), ADR-028 D11 (pictures a model looks at); Cascade ADR-012, ADR-039, ADR-052,
ADR-073, ADR-078 and `packages/core/src/context/` (the source)

## Context

On 2026-09-24 gpt-6-luna read the office picture with `run_code` and stopped twice with "context-full":
once at step nine, once at step thirty-six with the walls drawn and two thirds of the furniture still to
place. Nothing was wrong with the model. What failed was this project's own context management, built
for ADR-025, and it failed in ways the owner's other agent, Cascade, had already measured and solved:

| | Cascade | ADR-025, as built here |
|---|---|---|
| Reasoning | never replayed, never counted (its ADR-078 rung 1b: phantom thinking fired compaction early) | encrypted reasoning replayed every turn and counted, and no layer could remove it |
| What is counted | chars/4 over text, tool inputs and tool results, plus a wire overhead *measured* from the server's real prompt size | everything, pictures by the length of their base64, against a fixed budget |
| Window | the model's own (a map of known windows, the server's own answer on Ollama), overridable | one number from `.env`, sized for a local model, applied to a hosted one |
| Thresholds | one plan whose large-window limit is exactly Claude Code's (`auto = window − 20k − 13k`), `max`'d with a proportional floor for small windows, with `warn` and `hard` tiers and a wire wall | a budget and a target |
| Layers | collapse → mask → microcompact → snip → summarize, cheapest first, stopping under `auto` | superseded → receipt → discard → shield, and then nothing |
| Tool inputs | `snip` stubs large inputs (a whole script) to a one-line record | never touched |
| When the layers run out | a structured summary of the older region, task and latest instruction kept verbatim, turn-aligned, monotonic, with a circuit breaker | "context-full" and the run ends |
| When the server refuses the prompt | forced compaction and a retry | the run ends |
| Local servers | constrained mode: compact rarely and deep, triggered by measured growth | the same stopping rule as a hosted API |

Cascade's context layer was built over two months against measured incidents, each written into its
code and its ADRs. The owner has asked for it to be the base here, ported rather than re-derived, and
improved on from there.

## Decision

### D1. The code is Cascade's

`packages/agents/src/context/` holds `compactionPlan.ts`, `compactionLayers.ts`, `compactor.ts` and
`windows.ts`, ported from Cascade's `packages/core/src/context/` and `llm/contextWindows.ts`, with the
owner's permission (2026-09-24). Cascade has no licence file; its author is this project's author, who
has released this copy under this repository's Apache-2.0 licence. The constants, the ladder, the layer
order, the shields, the survival rule, the summarize gates and every measured comment come across as
they are. Cascade's tests for them come across too, translated to our message shape.

The loop's side of it -- measure the wire overhead after every reply, sample per-turn growth, compact
before every call, force a compaction and retry when the server says the prompt is too long -- is
ported into `runner.ts` from Cascade's `agentLoop.ts` and `resilience.ts`.

### D2. What had to change, and nothing else

Each of these is forced by a difference between the two projects, and each is marked in the code as an
adaptation.

1. **Tool names.** Cascade's tools are Read, Grep, Glob, Edit, Write and Bash. The equivalents here:
   - *re-readable observations* (collapse, mask, microcompact): `get_scene`, `describe_room`, `measure`,
     `validate`, `search_catalog`, `project`, `history`, `get_bom`, `query_design`, `look_at`,
     `preview_design`, `render`, `read_page`, `web_search`, `read_skill`.
   - *large inputs* (snip): `run_code`, `batch`, `check_design`, `revise_design`, `design_layout`,
     `create_walls`.
   - *collapse keys*: the tool name and its arguments, as ADR-025 D2 already keyed superseding: two
     `describe_room` calls about different rooms are not the same read.
   - *load-bearing, never evicted*: `plan_work`, `notes`, `ask_user` (a person's answer) and
     `design_layout` (the architect's design). Cascade's `mask` layer is size-only and would mask a large
     load-bearing result too; here it skips these four, because the generic stub would tell the model to
     "call the tool again", and calling `design_layout` again runs the whole architect a second time.
2. **Stubs for a change.** Cascade's stub says "re-run the tool if you still need this". Re-running
   `place_item` places a second chair, so a mutating tool's stub instead keeps the ids its result named
   and says to read the scene again (ADR-025 D6's receipt, inside Cascade's stub).
3. **The unconsumed-read shield.** Cascade shields a Read whose file has not been edited since. Here a
   read is `describe_room` or `get_scene` with a target, and it is consumed by a mutating call on the
   same room, wall or level.
4. **Arguments are text.** Our `tool_use` keeps the model's arguments as it wrote them (ADR-029 D1), so
   the target of a call is parsed from that text where Cascade reads an object.
5. **Pictures.** Cascade does not count images and evicts stale tool-result screenshots, never a
   person's upload. The same here: renders lifted into the conversation are evicted but for the newest,
   an attachment is never touched, and neither is counted (the measured overhead absorbs their cost).
6. **Reasoning.** Not replayed on any wire, not counted, not kept on any assistant message but the
   newest -- except that Claude requires the thinking of the turn being continued, so the Anthropic
   adapter sends the newest assistant message's thinking and nothing older. ADR-029 D1's replay of
   OpenAI's encrypted reasoning is withdrawn.
7. **The summary prompt.** Cascade's is about files. Ours asks for the same sections with an **entity
   ledger** in place of the file ledger: every wall, room, opening and item made, by id, and what it is.
   The failure it prevents is the same one: a model that forgets what it built re-reads, or rebuilds.
8. **Curation.** Cascade harvests facts into memory before a summary discards them (its ADR-074). There
   is no memory here; the hook stays, unset.
9. **The window.** `profile.contextTokens` when a person set it, else the server's answer (Ollama), else
   the map, else Cascade's default. The map gains the models this project uses: gpt-6 and gpt-5.6
   (400,000 until a measured number replaces it), current Claude models (1,000,000; Haiku 4.5 200,000).

### D3. Economics follow the wire

Hosted wires (OpenAI Responses, Claude, OpenRouter) run Cascade's hosted rule: free the minimum, stop
under `auto`. Ollama runs Cascade's constrained rule (its ADR-078): trigger from the measured p75 of
per-turn growth, compact deep to leave 45% of the window free, always summarize.

### D4. What ADR-025 keeps

`forNextRun` -- what a finished run leaves for the next message in the same chat -- is not Cascade's
concern and stays as ADR-025 D5 wrote it. The model is still told, in the prompt, that re-reading the
scene is how it recovers what was dropped (D6).

### D5. Improving on it

The owner's instruction is that this is the base and it can be made better. Every improvement is a
separate change with its own measurement, never folded into the port, so a regression can always be
traced to the change that caused it rather than to the port.

## Alternatives considered

- **Patch ADR-025's layers.** Proposed on 2026-09-24 and rejected by the owner: it would have added an
  input-shortening rule without the escalation order and shields that make one safe, and it would still
  have been a second design of something that already exists and is measured.
- **Import Cascade as a package.** Rejected: its context layer depends on its message types, its tracer
  and its provider interface; the port is smaller than the adapter would be.

## Consequences

- The run that stopped at step thirty-six has room to finish, and the next stop, if there is one, is a
  summary rather than an ending.
- ADR-025's measurements (the 48% fixed cost, the eight-result shield, the 545-token growth seed) are
  history; Cascade's constants replace them, and new measurements on this project's runs decide any
  change.
- `compact.test.ts` is replaced by Cascade's context tests, translated.
