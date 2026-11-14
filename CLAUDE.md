# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

An AI voice receptionist: a conversation-flow engine on the Anthropic Messages API (`@anthropic-ai/sdk`), in TypeScript on Node 24. A Flow, defined as data, says how a Call can unfold. The engine runs one Node at a time, answers each Caller Turn as the Receptionist, and follows an Edge or ends the Call in an End state. Today the only channel is a terminal chat (`npm run chat`), and the Flow is a single `start` Node with a `goodbye` End state. The spec is `PRD.md` and the vocabulary is `GLOSSARY.md` (Call, Flow, Node, Edge, End state, Turn, Receptionist, Caller). Use those terms in code, comments and docs. `Session` is only the code-level name for a Call's state.

## Commands

Run from the repo root. Flow paths and `.env` are resolved relative to the working directory (the CLI's default Flow path is the exception: it is relative to the project).

```bash
npm ci                                # install, versions are pinned
npm run typecheck                     # tsc --noEmit, strict
npm test                              # vitest run, offline, no API key
npm run chat                          # talk to the Receptionist in the terminal (needs ANTHROPIC_API_KEY)
npm run test:live                     # opt-in smoke test against the real API (RUN_LIVE=1), spends money
cp .env.example .env                  # then set ANTHROPIC_API_KEY (.env is git-ignored, never commit a key)
```

- `npm run chat` reads `ANTHROPIC_API_KEY` from the environment or `.env`. With no key (or the `sk-ant-...` placeholder) it prints a `ANTHROPIC_API_KEY is not set` message and exits 1. `FLOW_PATH` overrides the Flow file (default `flows/receptionist.json`).
- To run one test file: `npx vitest run test/turn.test.ts`.
- `npm test` skips `test/live.test.ts`. `npm run test:live` fails with the missing-key message if there is no key.

## Architecture

The Flow is data and the engine interprets it. Changing how a Call behaves usually means editing `flows/receptionist.json`, not TypeScript.

- **`flows/receptionist.json`** is the Flow: `base_instructions`, `variables`, `default_model`, `start_node`, `nodes`, `edges`, `end_states`. Nodes may override `model` and `effort`. Model references look like `anthropic/<id>` or `openrouter/<vendor>/<model>`.
- **`src/flow/`**: `schema.ts` is the Zod schema plus cross-reference checks (unknown Edge targets, duplicate ids, unreachable Nodes, unknown tools). `load.ts` reads and validates a Flow file. A bad Flow throws `FlowValidationError` listing every problem.
- **`src/engine/engine.ts`**: `FlowEngine` has `start(callId, ctx, stream?)` and `handleUser(callId, utterance, turnId, stream?)`. A Turn runs up to `maxHops` Nodes (default 4) on the same utterance, which guards against routing loops. State lives in a `Session` held by a `SessionStore` (only `InMemorySessionStore` exists; it stores clones, so it behaves like an external store).
- **`src/engine/run-node.ts`**: `runNode` makes one model call with the Node's rendered instructions as the system prompt (`base_instructions` first). `MAX_TOKENS` is 1024.
- **`src/adapters/`**: `chat.ts` is the terminal Call loop (`runChat`), `cli.ts` wires readline and the real client, `terminal-reply.ts` renders streamed replies and erases withdrawn ones. Adapters are thin and the engine knows nothing about terminals.

### Model client

`ModelClient` (`src/engine/model.ts`) is the only seam to a model: `createMessage(req, onTextDelta?)` returns content blocks and a `stopReason`. `AnthropicModelClient` (`src/engine/anthropic-client.ts`) is the real one and `FakeClaude` (tests) is the scripted one. `ModelRequest` deliberately has no `temperature`, `top_p` or `top_k`, which Sonnet 5.5 rejects. The Anthropic client always sets adaptive thinking, `output_config.effort` from the Node (default `low`, since the API default is too slow for voice), and the server-side fallback beta.

### Edges, transition tools and End states

- Each Edge from the current Node is offered to the model as a strict tool named `transition__<edge_id>`, described by the Edge's `condition.prompt`. Strict tools, not forced `tool_choice`, are how the engine steers the model, because forced `tool_choice` is a 400 on Sonnet 5.5.
- If the model calls one, the engine moves to the target and re-runs it on the same utterance. Text already said this Turn is injected into the next Node's system prompt so it does not greet again, and the reply is the pieces joined with a single space. If several Edges are called, the first wins.
- An Edge whose `to` is an End state finishes the Call: the End state's templated `message` is spoken after anything already said (even nothing), `Session.endState` is set and the result has `ended: true`. The Node's instructions must tell the model not to say a farewell of its own. An ended Call rejects further Turns, though a replay of the ending Turn still returns its stored result.
- A refusal (`stopReason: "refusal"`, which is a normal HTTP 200) discards the whole Turn: the Call stays on its Node and `REFUSAL_LINE` is spoken. An empty reply becomes `EMPTY_REPLY_LINE`. A refused response never takes an Edge.
- `{{var}}` templating (`templating.ts`) applies to instructions and End state messages. An unknown variable throws `UnknownVariableError`.

### Turns, transcript and idempotency

`handleUser` is idempotent on `turnId`: a repeat returns the stored `TurnResult` without calling the model or touching the transcript. Turns on one Call run one at a time (a per-Call queue). A Turn that throws is not recorded, so the Caller can retry. `Session.transcript` holds plain text only. Tool calls and thinking are never replayed across Turns, so anything that must persist goes in `Session.variables`.

### Streaming rule

`ReplyStream` (`src/engine/reply-stream.ts`) has `text(delta)` and `discard()`. The rule every stream can rely on: when a Turn finishes, what the stream was shown is exactly the Turn's reply, End state message and safe lines included. If the reply changed after text was shown (a refusal, or a failed request), `discard()` is called first, everything shown is void, and the true reply follows from nothing. `ReplyWriter` enforces this, so engine code never writes to a stream directly. Keep it intact when changing the engine or adding an adapter.

## Testing

Tests are vitest files in `test/` and run offline. `test/fake-claude.ts` is a scripted `ModelClient`: build it with the ordered responses the model would give (`say("...")`, `reply([...blocks], stopReason)`, `failAfter(text, error)`), inject it with `new FlowEngine(flow, { client })`, then assert on `TurnResult`, the session in the store, streamed text and the recorded `requests` (system prompt, tools, `model`, `effort`, `maxTokens`). Requests are cloned when recorded, so later mutation by the engine does not leak into them. It streams word by word like the real client. `test/sse.ts` builds canned HTTP streams, so `anthropic-client.test.ts` exercises the real SDK with no network. Any new Flow behaviour should be testable this way.

`test/live.test.ts` is the opt-in check against the real model. It asserts facts that hold on every run (name, no markdown, closing message appears once, stream equals reply), not exact wording.

## Gotchas

- Node 24 is required (`engines`), and `process.loadEnvFile` is used for `.env`. The PRD still says Node 22+.
- Dependencies are pinned to exact versions, including `@anthropic-ai/sdk`. The SDK is called through `client.beta.messages.stream`, because `betas` and `fallbacks` do not exist on the plain Messages API.
- Never send `temperature`, `top_p` or `top_k`. Never disable thinking (`{type:"disabled"}` is a 400 on Sonnet 5.5) and never use prefill. Always set effort explicitly.
- Adaptive thinking counts toward `max_tokens` even though it is not returned, which is why the cap is 1024 and not the 300 an earlier draft planned. Replies stay short because the Flow's instructions say 1 to 3 sentences with no markdown, since every reply is read aloud.
- A tool call cut off by a refusal or by `max_tokens` is dropped by the client, never used.
- vitest has no config and uses its default include globs. Run from the main checkout, it also picks up copies of the tests inside `.claude/worktrees/*`, so run it from inside the checkout or worktree you are working in.
- `.env.example` lists `OPENROUTER_API_KEY` and `DB_PATH`, but nothing reads them yet.

## Not built yet

From PRD section 15 (Phase 2): `speak` and `tool` Node types, `expression` Edges, post-verification business Nodes (account lookup, transfer), the Telnyx TeXML voice adapter with a status callback for cleanup, an external session store, webhook signature verification, AWS deployment. Also not built, though the PRD's Phase 1 plans them: the `verify` Node and SQLite, a tool registry and business tools (a Node's `tools` list must be empty today, and `runNode` ignores business tool calls), the HTTP adapter, an OpenRouter client (the schema accepts `openrouter/...` models but `AnthropicModelClient` throws on them), and `MAX_HOPS` / `SESSION_TTL_SECS` configuration.

Known gaps:

- `start()` ignores `stopReason`, so a refused or empty greeting is shown as is. Only `handleUser` applies `REFUSAL_LINE` and `EMPTY_REPLY_LINE`. It also offers no transition tools while greeting.
- The live Anthropic path has never been exercised against the real API. `AnthropicModelClient` is tested only against canned streams, and `npm run chat` and `npm run test:live` have not been run with a key.
- Nothing expires a Call that is abandoned mid-way, since `InMemorySessionStore` has no TTL.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `bitlabsdevteam/AI_receptionist_claude_sdk`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
