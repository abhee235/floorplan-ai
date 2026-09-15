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

## Alternatives considered

- **Anthropic SDK plus OpenAI SDK plus Ollama SDK.** Rejected: three code
  paths for the same loop. The OpenAI-compatible format is the common
  denominator all of them speak.
- **LangChain or a framework.** Rejected: the loop is small, and framework
  abstractions hide the tool-call details we need to tune.
- **Relying on vendor structured output.** Rejected: uneven support and
  behaviour across the providers we must run on.

## Consequences

- `agents` depends on `@modelcontextprotocol/sdk` (client), zod, and a
  fetch-based OpenAI-compatible client with no vendor SDK.
- The runner is where step budgets, retries and transcript recording live;
  the host stays unaware of which model is calling.
- Plan Reader quality on local hardware depends on the Qwen vision model
  chosen; ADR-011 designs for correction rather than perfection.
