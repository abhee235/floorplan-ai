# ADR-007: Provider abstraction over OpenAI-compatible APIs; agent runner; Claude Code for development

Status: Proposed
Date: 2026-09-14
Supersedes: section 5.6 of 00-brainstorm.md
Related: ADR-005 (host), ADR-006 (tools), ADR-011 (plan reader)

## Context

During development Claude Code plays every agent role by hand through MCP.
The shipped in-app agent will run on local Qwen models, OpenAI, or
OpenRouter. The Plan Reader needs image input. Tool calling quality differs
widely between these, and structured-output features differ between vendors.
We need one thin interface, one runner, and an evaluation loop that tells us
which tools and prompts work on which models.

## Decision

### D1. One provider interface, OpenAI-compatible wire format

```
Provider {
  id: string
  profile: { vision: boolean, toolCalls: boolean, toolReliability: "high" | "medium" | "low", contextTokens: number, jsonMode: boolean }
  complete(req: { system, messages, tools?, images?, temperature?, maxTokens? }): Promise<{ text?, toolCalls?: ToolCall[], usage, raw }>
}
```

The single implementation speaks the OpenAI chat completions format with
tool calling and image content parts. That covers OpenRouter, OpenAI, and
local servers (Ollama, vLLM, LM Studio) hosting Qwen models. No vendor
specific features are used in agent code. Claude is reachable through
OpenRouter with the same implementation if ever wanted at runtime; the
Anthropic SDK is not a runtime dependency.

Configuration is a JSON file or environment: `{ baseUrl, apiKey, model,
profile overrides }`. Multiple named providers can be configured; the app
picks one per role (reader, designer, verifier).

**Amended 2026-09-20: one interface, two wires, and the second one is not
optional.** The interface above is unchanged. What changes is the claim that
one wire format reaches every server worth reaching, because on the server this
project is built to run on it does not.

The context a model is loaded with cannot be set over the OpenAI chat
completions format. That format has no field for it, so Ollama's compatibility
layer has nothing to map, and it ignores `num_ctx` at the top level and inside
an options object alike while accepting fields it has never heard of in
silence. Ollama's own documentation says so, listing fifteen supported fields,
none of them a context field, and pointing anyone who needs one at a model file
instead. Measured here on Ollama 0.32, four requests asking four different ways
all loaded the same 131,072 tokens.

That would be a tolerable limitation if the number did not matter. It matters
more than anything else about a local model. A 35B build of 18.6 GB whose
architecture declares 262,144 tokens is sized for that declaration, the cache
overflows the card, the host allocation fails, and the server answers 500 --
which reads as "this machine cannot run this model" and is not true. Asked
natively for 16,384 the same build loads with 14 GB on the card and answers
normally. The setting is the difference between the model running and not.

Nor can it be had by the side door. Warming a model natively at 16,384 and then
sending one ordinary request on the compatible wire reloads it at 131,072 and
discards the warm-up. There is no arrangement in which we keep one wire and
still choose the number.

So Ollama gets a native transport, behind the same `Provider` interface, and
these lines are drawn:

- The interface, the runner, the roles and every caller are unchanged. A
  transport is a detail of one provider, not a second abstraction for callers
  to know about.
- It is chosen by what the server is, not by what the user asked for. An
  address that answers Ollama's version endpoint is Ollama; everything else
  stays on the compatible wire, which remains the default and the only wire for
  OpenAI, OpenRouter, vLLM and LM Studio. D1's point was never the format for
  its own sake; it was one code path for every hosted vendor, and that holds.
- It carries the context we ask for, the output cap, and nothing else that the
  compatible path does not already carry. A second wire is a second set of
  quirks to learn, and the way to keep that cheap is to send as little down it
  as possible.
- The context we ask for comes from the profile's `contextTokens`, which until
  now was a number nothing in the loop read. A wire that can carry it is the
  reason to start computing it honestly, and the budget that spends it is
  ADR-022 D8.

Two things fall out that are worth having for their own sake. The native reply
reports how long the prompt took to evaluate and how long generation took,
separately, which is the measurement a local run needs and the compatible wire
cannot give. And a probe of the model's own description tells us what context
it was built with and what its model file overrides, so the number we ask for
can be a decision rather than a guess -- capped, because a model that declares
262,144 tokens is telling us what it was trained for, not what will fit.

### D2. Structured output is ours, not the vendor's

Agent outputs that must be data (a plan draft, a room brief parse, a product
proposal) are requested as JSON in the prompt with the zod schema rendered
as JSON Schema, then parsed and validated by us. On failure the validation
error is fed back and the model retried, at most three times, before the
runner reports failure. Vendor JSON modes are enabled when the profile says
so but are never relied upon.

### D3. The agent runner calls the registry in-process

`agents` contains a runner that: takes the tool registry (ADR-005 D1)
filtered for the provider's profile (ADR-006 D6), runs the conversation loop
with tool calls executed as direct function calls against the host's
project, applies per-call timeouts, stops after a configurable step budget,
and records a transcript of every prompt, tool call, tool result and token
usage. Temperature is 0 for tool-calling turns.

The runner lives inside `apps/host`, so there is no protocol between the
agent and the tools and nothing extra to deploy. The same runner can be
handed an MCP client instead of the registry when it runs as an external
process, which is only used for evaluation harnesses, never in production.

Roles are prompt plus tool subset plus schema, not separate services:

| Role | Tools advertised | Output |
|---|---|---|
| Plan Reader | none during extraction; then `batch`, `validate` | PlanDraft JSON (ADR-011) |
| Space Designer | semantic and inspect tools | commands via tools |
| Catalog Verifier | web search and fetch providers (ADR-008) | ProductProposal JSON |
| Reviewer | inspect tools only | list of problems and fixes |

### D4. Development loop with Claude Code

Claude Code connects to the same host over stdio and receives the full tool
list. Every session's transcript is recorded by the host as well, so a
workflow that Claude Code performed by hand becomes a replayable test:
the same tool calls are issued to a fresh project and the resulting IR is
compared.

### D5. Evaluation

`tools/eval` holds task cards ("10-seat boardroom, 8 by 5 m, video
conferencing"), a scoring script (validation clean, required items present,
BOM verified fraction, step count, tokens), and runs each card against each
configured provider. Results are a table checked into `docs/eval` per
release. This is how tool descriptions and semantic tools are tuned, and how
a model is admitted to the "low" or "medium" reliability tier.

### D6. Privacy and cost

Images and briefs are sent only to the configured provider. A local provider
is the default suggestion for plan reading when the profile has vision. Token
usage is recorded per session and shown in the app.

### Implementation (2026-09-16, PRD P1-7 and P1-8)

- **Runner.** `@fpv/agents` `runAgent` is a provider-neutral loop: one model
  turn per step at temperature 0, tool calls run in order through a
  `callTool` function (the registry in the host), results fed back as tool
  messages. Malformed arguments and unknown tools become error envelopes with
  a hint rather than exceptions; tool calls that local models write into the
  reply text (`<tool_call>` blocks) are read as calls. Transient provider
  failures (network, 429, 5xx) are retried twice with backoff. A run stops on
  a plain answer, the step budget (default 40, with a warning three turns
  before), three identical failing calls in a row, a permanent provider
  error, or an abort. Tool results lose image data and are cut at 16,000
  characters with a note to narrow the call. Every request, reply, retry and
  tool call is an event.
- **Designer role.** `registryToolSpecs` renders the registry's tools for the
  profile's reliability (ADR-006 D6) as JSON Schema via zod-to-json-schema,
  without `additionalProperties: false` (unknown keys are warnings);
  `DESIGNER_SYSTEM` is the workflow prompt plus the role. The schemas cost
  about 9,000 tokens at high or medium reliability and 5,000 at low.
- **Host.** `apps/host/src/agent.ts` takes the model from `roles.designer` or
  `FPV_AGENT_*`, and `runAgentTask` appends every event to a JSONL transcript
  in `<data>/transcripts` as it happens. `host --agent "<task>"` runs one task
  (with `--serve` a browser tab watches).
- **Evaluation.** Task cards in `tools/eval/cards` (`boardroom`,
  `import-office`), scoring in `tools/eval/cards.ts` (rooms, item categories
  and counts, walls, validation errors, BOM verified share, steps, tool calls,
  tokens, seconds), and `tools/eval/run.ts` running cards against
  `ollama:`, `openai:`, `openrouter:` and `config:` models. A model server that
  does not answer is skipped and a run whose provider failed before any reply
  is not recorded, so connection failures never appear as model results.
  Scores append to `docs/eval/agent-results.jsonl`; `docs/eval/agent-runs.md`
  holds the table. `tools/test/eval.test.ts` drives both cards with scripted
  providers through the real registry.
- **Provider parameters.** The one OpenAI-compatible implementation learns from
  a 400 reply that names a refused parameter and sends the request again,
  keeping the change for later requests: `max_completion_tokens` instead of
  `max_tokens`, the model's default temperature instead of 0, and
  `reasoning_effort: "none"` with function tools (newer OpenAI models accept
  tools on chat completions only without reasoning). `provider.adaptations`
  lists what changed. Reasoning with tools on OpenAI needs the `/v1/responses`
  API; an optional Responses path is a follow-up, to be compared in
  `docs/eval/agent-runs.md` before it becomes a default.
- **Configuration.** `.env` (see `.env.example`) sets
  `FPV_<AGENT|READER|VERIFIER>_PROVIDER` (`ollama`, `openai`, `openrouter`) and
  `FPV_<ROLE>_MODEL`; the host fills in base URL, key and, for Ollama,
  `reasoning_effort: "none"`. The Ollama server must run with a context larger
  than its 4,096-token default (`OLLAMA_CONTEXT_LENGTH`).
- Cascade, the project owner's coding agent, informed the event stream,
  errors as tool results, profile-filtered tools and fake-provider tests; no
  code was taken from it.

## Alternatives considered

- **Anthropic SDK plus OpenAI SDK plus Ollama SDK.** Rejected: three code
  paths for the same loop. The OpenAI-compatible format is the common
  denominator all of them speak.
- **LangChain or a framework.** Rejected: the loop is small, and framework
  abstractions hide the tool-call details we need to tune.
- **Relying on vendor structured output.** Rejected: uneven support and
  behaviour across the providers we must run on.

Considered again on 2026-09-20, when the context problem forced the question:

- **Tell people to build a model file with the context baked in.** This is what
  Ollama's documentation advises and it does work; one of the models installed
  here is built that way. Rejected as the answer because it puts the setting
  outside the app, where the app cannot see it, cannot change it per run and
  cannot explain it. A person who picks a model from a list should not have to
  rebuild it before it will load, and telling them to is telling them the tool
  does not work.
- **Move every provider to its own native wire.** Rejected: it is the same
  three-code-paths mistake D1 rejected at the start, and it buys nothing. The
  hosted vendors speak the compatible format natively and have no equivalent
  setting to reach for.
- **Ask for a large context and let the server sort it out.** Rejected by the
  failure that started this: sizing for a declared 262,144 tokens is exactly
  what made a model that fits refuse to load. The number has to be chosen, and
  chosen small enough to leave room for the weights.
- **Warm the model up natively, then use the compatible wire.** Rejected on
  measurement rather than taste: the next compatible request reloads the model
  at its own size and throws the warm-up away.

## Consequences

- `agents` depends on `@modelcontextprotocol/sdk` (client), zod, and a
  fetch-based OpenAI-compatible client with no vendor SDK.
- The runner is where step budgets, retries and transcript recording live;
  the host stays unaware of which model is calling.
- Plan Reader quality on local hardware depends on the Qwen vision model
  chosen; ADR-011 designs for correction rather than perfection.
