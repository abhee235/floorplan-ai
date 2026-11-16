# ADR-029: One adapter per wire, over a conversation that belongs to no vendor

Status: Proposed
Date: 2026-09-24
Supersedes: ADR-007 D1 ("one provider interface, OpenAI-compatible wire format") and its alternative
"move every provider to its own native wire"
Related: ADR-007 (the runner, D2 to D6 unchanged), ADR-025 (compaction works on the conversation this
changes), ADR-028 D11 (pictures lifted into the conversation), ADR-030 (the code sandbox, which is what
this was found on the way to); Cascade's `packages/core/src/llm` (the owner's own agent, the structure
followed here)

## Context

ADR-007 D1 chose one interface and one wire: the OpenAI chat completions format, which OpenAI,
OpenRouter, vLLM, LM Studio and Ollama all speak. It was amended once already, on 2026-09-20, when
Ollama turned out to need its own wire to carry the context a model is loaded with. That amendment kept
the claim that every hosted vendor could share one code path.

That claim is now false for the vendor the agent runs on. Measured on 2026-09-24 with the owner's key:

| Model | `/v1/chat/completions` with reasoning and a tool | `/v1/responses` with reasoning and a tool |
|---|---|---|
| gpt-6-luna | 400: "Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'." | a tool call |
| gpt-6-sol | the same 400 | a tool call |

The compatible provider learnt that refusal as a quirk and sent `reasoning_effort: "none"` from then on,
whatever `.env` asked for (`provider.ts`, `reasoningNone`). So every in-app run on OpenAI since the
quirk was written has been a reasoning model with its reasoning switched off. The runs that ADR-028 and
`docs/eval/office-live.md` measured were measured that way, and nobody could see it except in an
adaptation line.

The owner's own agent, Cascade, reached the same wall in July and went round it the way this ADR does:
a `ModelProvider` interface, a conversation held in provider-neutral content blocks, and one adapter per
wire -- `openaiChat` for the compatible servers, `openaiResponses` for OpenAI, `ollama` for Ollama's
native API -- chosen by a factory from the provider's name. The owner had asked for that structure here
and it was not followed; the single interface stayed OpenAI-shaped all the way down.

The shape is the real problem, more than the missing endpoint. The conversation the runner keeps is
OpenAI's chat format: `image_url` parts, a `tool` role, arguments as a string on the assistant message,
the system prompt as a message. Every other wire is a translation *from OpenAI's*, and the next one
makes that worse:

- **Responses** has no messages at all. It takes a flat list of items: `function_call` and
  `function_call_output` keyed by `call_id`, `input_image` parts, the system prompt as `instructions`,
  and reasoning as items of their own that can be carried from one request to the next.
- **Claude** (Anthropic's Messages API) has content blocks: `tool_use` and `tool_result`, image blocks
  with a base64 source, the system prompt as a field, and thinking blocks with a signature that must be
  sent back unchanged. All the results of one turn go back in a single user message. Current models
  refuse a temperature, and depth is set by an `effort`, not a token budget.
- **Ollama** carries images beside the text, arguments as objects, no call ids at all, and thinking as
  its own field.

Four wires, and the one we had made the internal format is the one that has least in common with the
other three.

## Decision

### D1. The conversation is ours, in content blocks

The runner, compaction, the saved conversation and every role hold messages in one neutral form
(`packages/agents/src/llm/messages.ts`):

```
Message = { role: "user" | "assistant", content: string | Block[] }
Block   = { type: "text", text }
        | { type: "image", url }                        -- a data: URL or an https address
        | { type: "tool_use", id, name, arguments }     -- arguments as the model wrote them
        | { type: "tool_result", toolUseId, content, isError? }
        | { type: "reasoning", wire, data, text? }      -- opaque, for the wire that made it
```

This is Cascade's vocabulary (text, image, tool_use, tool_result), with two differences and a reason
for each:

- **`arguments` stays the string the model wrote**, not a parsed object. The runner's repair ladder
  (fenced JSON, wrapped JSON, `<tool_call>` text) works on the raw text, and a transcript that records
  what the model said is worth more than one that records what we made of it. An adapter whose wire
  wants an object parses it at the boundary, and sends the string when it will not parse.
- **Reasoning is a block** that the loop keeps and never reads. *(Amended by ADR-031 D2.6: reasoning is not replayed on any wire; only Claude's thinking for the turn being continued is sent, and only the newest assistant message keeps any.)* Each adapter tags what it produced with
  its own wire name, and sends back only blocks tagged with that name: a Claude thinking block with its
  signature, an OpenAI reasoning item with its encrypted content. Another adapter drops them, which is
  what each vendor does with the other's reasoning anyway. This is what makes a model's thinking survive
  a tool call instead of starting again after every one.

The system prompt is a field of the request, never a message. Tool results are user-turn blocks, as
Claude's API has them.

One rule is ours rather than Cascade's, because compaction (ADR-025) depends on it: **a tool result is
a user message of its own, holding exactly one `tool_result` block.** Compaction replaces, receipts
and drops results one at a time by index, and that is four layers of carefully measured behaviour we
are not rewriting to change a representation. The adapters merge a run of result messages into
whatever their wire wants -- one user message for Claude, one `tool` message each for chat
completions, one `function_call_output` item each for Responses. A picture lifted from a render
(ADR-028 D11) rides on its own user message after the results; the adapters put results first
wherever a wire requires it.

### D2. One interface, one adapter per wire, a factory that picks by name

```
ModelProvider {
  id, model, profile, adaptations
  ready?(): Promise<void>
  complete(req): Promise<Completion>
  stream?(req): AsyncIterable<StreamEvent>
}
```

The interface is the one we have, which was already neutral; the stream events (text, reasoning,
tool-call fragments, finish) were neutral too. What changes is that `CompletionRequest.messages` is the
D1 conversation and a completion may carry reasoning blocks to keep.

Four adapters, each owning its wire and nothing else, in `packages/agents/src/llm/`:

| Adapter | Wire | Used for |
|---|---|---|
| `openai-chat.ts` | `/chat/completions`, with the refusal-learnt parameter spellings | OpenRouter, vLLM, LM Studio, any compatible server |
| `openai-responses.ts` | `/v1/responses`, stateless (`store: false`), full history each turn | OpenAI |
| `anthropic.ts` | Messages API through Anthropic's own SDK | Claude |
| `ollama.ts` | `/api/chat`, with the context the model is loaded with | Ollama |

`factory.ts` builds a provider from configuration. An explicit `api` wins; otherwise the provider's name
decides: `openai` is Responses, `anthropic` is Claude, `ollama` is native, anything else is the
compatible wire. An address with no name is still asked whether it is Ollama, as today, so a person who
only typed a URL loses nothing. Adding a vendor that speaks the compatible format needs no code at all;
adding one that does not is one file and one line in the factory. This is how Claude gets in: not
through OpenRouter's translation of it, but as itself.

The factory is the only place that knows the adapters exist. The runner, the roles and the host see a
`ModelProvider`.

### D3. Each adapter uses its vendor's client when there is a good one

ADR-007 kept vendor SDKs out because one wire needed none. With one adapter per wire that reason is
gone, and the vendor's own client is the thing most likely to be right about its own streaming format,
retries and error types. So:

- **Claude uses `@anthropic-ai/sdk`**, inside `anthropic.ts` only. Its streaming events, its typed
  errors and its message types are used as they are rather than re-implemented.
- **OpenAI's two wires and Ollama stay on `fetch`.** They already work that way, they are tested that
  way, and the compatible adapter has to talk to servers that are not OpenAI. Moving Responses onto the
  `openai` package later is a change inside one file.

No SDK type leaves its adapter. The boundary rule is enforced by `tools/check-boundaries.ts`.

### D4. Reasoning is a setting of the role, said once, translated per wire

`.env` gains `FPV_<ROLE>_REASONING` (`none`, `low`, `medium`, `high`), and `FPV_<ROLE>_API` for the
rare case the name does not decide the wire. Each adapter says it its own way: `reasoning.effort` on
Responses, `output_config.effort` with adaptive thinking on Claude, `think` on Ollama,
`reasoning_effort` on the compatible wire. `reasoning_effort` in an existing `FPV_<ROLE>_EXTRA_BODY`
is still read as the setting, so nobody's `.env` breaks. Unsaid, the vendor's default applies.

The compatible adapter keeps learning from refusals (ADR-007, implementation notes), and keeps saying
so in `adaptations`: that is still how a server that will not think with tools is survived, but it is
no longer where OpenAI goes.

### D5. Saved conversations are read in either form

A conversation saved before this change is OpenAI-shaped. It is converted when it is read
(`fromLegacyMessages`): an assistant message's `toolCalls` become `tool_use` blocks, a `tool` message
becomes a user message with one `tool_result`, `image_url` parts become image blocks, a `system`
message is dropped (the system prompt is rebuilt every run). Nothing is rewritten on disk until the
conversation is next saved, so going back to an older build loses nothing but the newest turn.

## Alternatives considered

- **Keep the OpenAI shape and add Responses as a translation from it.** Rejected: it makes the least
  representative wire the source of truth, and Claude would then be a translation of a translation.
  It is also what was asked not to be done.
- **Reach Claude through OpenRouter's compatible endpoint.** Rejected as the way in: a translation
  layer cannot carry thinking signatures faithfully, and the owner asked for Claude as a provider in
  its own right. OpenRouter stays available for what it is good at, many models behind one key.
- **Rewrite compaction to work on blocks inside one user message.** Rejected for now: D1's one result
  per message costs nothing at the wire, because the adapters merge, and it keeps ADR-025's measured
  behaviour exactly as measured.
- **Use every vendor's SDK.** Rejected for OpenAI's wires and Ollama for now (D3): working, tested
  code would be replaced for no measured gain.
- **Server-side state on Responses (`store: true`, `previous_response_id`).** Rejected: our compaction
  rewrites history, and a server holding its own copy would disagree with ours. Stateless, with
  encrypted reasoning carried in our history, gives the same continuity.

## Consequences

- The measurements in `docs/eval` taken on OpenAI before this ADR were taken with reasoning off. The
  first runs after it are a new baseline, not a comparison, and are recorded as such.
- `@fpv/agents` gains `@anthropic-ai/sdk` as a dependency; nothing else does.
- `ChatMessage`, `ContentPart` and `openAICompatible` stop being the public surface of `@fpv/agents`.
  Their replacements are `Message`, `Block` and `createProvider`; `providerFor` remains as the name
  for "an address, asked what it is".
- `.env.example` documents `FPV_<ROLE>_REASONING`, `FPV_<ROLE>_API` and `ANTHROPIC_API_KEY`.
- Cascade's structure and names are followed; its code was read and not copied, because this
  repository is public and Cascade's licence is unstated.
