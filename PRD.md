# PRD: Receptionist Harness (an intelligent voice-agent harness, Telnyx-style)

| | |
|---|---|
| **Status** | Draft v0.2. The skeleton (tickets #1–#6, merged in PR #7) and a spoken Call in the terminal (#8, §8.6 Option C) are built. Everything marked **Planned** below is not built. |
| **Date** | 2026-11-16 |
| **Language / runtime** | TypeScript on Node.js 24+ |
| **Built today** | One `start` Node, a `goodbye` End state, terminal chat on Sonnet 5.5, a spoken Call in the terminal with an ElevenLabs Voice (§8.6 Option C), offline test suite. Nothing has run against the real Anthropic or ElevenLabs APIs. |
| **Next scope** | `verify` Node + SQLite, traces, an evaluation harness, then a Telnyx voice adapter |

---

## 1. Summary

Build the **harness** around Claude that lets an AI receptionist answer real phone calls like a Telnyx AI Assistant, and behave reliably when it does.

**Harness engineering**, as used in this document, means everything around the model that makes it dependable on a live Call:

- what goes into each model request (context assembly);
- which tools and Edges the model may use at each point (the Flow);
- deterministic **Guards** that hold whatever the model says;
- state and memory across Turns;
- routing, retries and fallbacks;
- **Traces** that show exactly what happened on every Turn;
- an **evaluation harness** that scores behaviour against Scenarios and catches regressions.

The governing rule is **the model proposes, code decides.** Claude writes the words and suggests the next step. Code owns every fact that matters: whether the Caller is verified, whether an Edge may be taken, whether the Call has ended, and whether a reply is fit to be spoken. "Intelligent" here means that the system measures itself and improves from its own Traces, not that it adds more autonomy to the model.

A Call is a **Flow**: a graph of **Nodes**, each with its own instructions, tools, model and outgoing **Edges**. The harness runs one Node at a time, takes the Caller's utterance, lets the model reply or propose an Edge, applies the Guards, and speaks the result. The Flow is data (JSON) and the harness interprets it, so later phases add Nodes by editing the Flow file, not the engine.

The agent loop is built on Anthropic's TypeScript SDK (`@anthropic-ai/sdk`). Sonnet 5.5 (`claude-sonnet-5-5`) is the default model. OpenRouter is an optional provider, so any Node can run a different model.

The first Flow has two Nodes:

1. **Start Node** greets the Caller and finds out why they are calling.
2. **Verify Node** verifies the Caller's identity against a SQLite database before anything else happens.

## 2. Goals and non-goals

### Goals
- G1. A flow-as-data engine. Adding or changing a Node should need no engine code change.
- G2. Per-Node model selection. Sonnet 5.5 is the default, and any Node can switch to an OpenRouter model.
- G3. The verify Node checks identity against SQLite. The pass/fail decision is made by code, never by the LLM.
- G4. The harness is testable offline with a scripted fake model client.
- G5. **Voice is the target channel.** The engine knows nothing about channels. A terminal chat and a spoken Call in the terminal (§8.6 Option C) exist first as development tools, and the Telnyx voice adapter is the first real channel (§8.6).
- G6. **Guards.** Rules about identity, Edges, End states and replies are enforced by code and hold whatever the model outputs (§8.3).
- G7. **Traces.** Every Turn produces a structured, PII-redacted record of what the harness did (§8.4).
- G8. **Evaluation.** Behaviour is measured with Scenarios, including a simulated Caller against the real model, with a regression gate (§8.5). A bad Trace can become a new Scenario.

### Non-goals (for now)
- A visual flow builder UI.
- Business Nodes after verification (leave balance, invoices, transfers and so on).
- A production database, an external store for Call state and AWS deployment. SQLite and in-memory Call state are deliberate stand-ins.
- Multi-tenant support and auth for the harness's own API.
- Autonomous behaviour beyond the Flow: the model never adds Nodes, tools or Edges at runtime.
- Real-time audio streaming with interruptions (barge-in). It is Option B in §8.6, after the first voice adapter.

## 3. Users and scenarios

- **Caller** reaches the Receptionist by voice (target) or typed text (development). They expect a short greeting, a simple identity check, then help.
- **Flow author (developer)** edits `flows/*.json`, the SQLite seed data and the Scenarios, and runs the Flow in the terminal chat.
- **Operator** (later) reads Traces and evaluation reports to find and fix bad behaviour.

### Core scenarios
| # | Scenario | Expected result |
|---|---|---|
| S1 | Caller says "hi" | Start Node greets, asks how it can help. Does not move on yet. |
| S2 | Caller states a reason ("I want to check my balance") | Start moves to Verify **on the same utterance**. The Receptionist does not re-greet and asks for verification details. |
| S3 | Caller gives valid ID + DOB | Verified. The Call's state records `verified=true` and `customer_id`. The Flow reaches the `verified` End state. |
| S4 | Caller gives wrong details | Generic "I couldn't verify that" with a retry. Nothing reveals which field was wrong. |
| S5 | 3 failed attempts | Lockout. The Flow reaches the `failed` End state. |
| S6 | Caller refuses to verify | Verify moves to the `failed` End state with a polite close. |
| S7 | Caller speaks digits as words ("one zero zero one") | Normalised before lookup. |
| S8 | Caller says goodbye at any point | The Call ends at the `goodbye` End state with one fixed closing message. **Built.** |
| S9 | Model refuses or returns nothing | A safe spoken line, no stored refused text, the Call stays on its Node. **Built.** |
| S10 | The model tries to take an Edge it is not allowed to take (for example `verified` without a pass) | The Guard rejects it and the Caller stays on the Node. Recorded in the Trace. **Planned with verify.** |
| S11 | The same webhook arrives twice | One Turn is recorded. The second request returns the stored reply. **Built** (idempotent on `turnId`). |

## 4. Architecture

### 4.1 Harness layers

```
 Channels                    Harness                                     Services
┌─────────────────┐  utt   ┌────────────────────────────────────┐     ┌──────────────────┐
│ Terminal  (built)│───────▶│ Control loop (FlowEngine)          │────▶│ ModelClient      │
│ HTTP     (planned)│       │  Context assembly                  │     │  Anthropic (built)│
│ Telnyx   (planned)│◀─reply─│  Edges (strict tools)              │     │  OpenRouter (plan)│
└─────────────────┘        │  Guards   ── model proposes,       │     └──────────────────┘
                           │  State        code decides         │     ┌──────────────────┐
                           │  Trace sink                        │────▶│ Tool registry    │
                           └───────┬────────────────────┬───────┘     │  (planned)       │
                                   │                    │             └────────┬─────────┘
                           Flow (JSON data)     Trace store (JSONL)    ┌────────▼─────────┐
                                                        │              │ SQLite (planned) │
                                              ┌─────────▼──────────┐   └──────────────────┘
                                              │ Evaluation harness │
                                              │ (Scenarios, judge) │
                                              └────────────────────┘
```

| Layer | Responsibility | Status |
|---|---|---|
| **Control loop** | `FlowEngine` runs up to `maxHops` Nodes per Turn, follows Edges, applies End states. | **Built** (`src/engine/engine.ts`, `run-node.ts`) |
| **Flow definition and validation** | Zod schema plus cross-reference checks. Rejects bad Flows at startup with every problem listed. | **Built** (`src/flow/`) |
| **Edges as strict tools** | Each Edge is offered to the model as a strict `transition__<edge_id>` tool. The engine, not the model, applies it. | **Built** |
| **Context assembly** | Builds the system prompt (`base_instructions`, then the Node's instructions, then text already said this Turn) and the message history. Refused and empty messages never enter history. | **Built** (basic). Caching and long-Call policy are **Planned** (§8.2). |
| **Safe replies** | Refusals and empty replies become safe spoken lines, and refused text is never stored. A truncated reply keeps complete Edge calls. | **Built** |
| **Idempotency and ordering** | Turns are idempotent on `turnId` and run one at a time per Call. | **Built** |
| **Streaming rule** | A stream is shown exactly the Turn's final reply, or told to discard first. | **Built** (`reply-stream.ts`) |
| **State** | `Session` (the Call's state) behind a `SessionStore`. | **Built** (in-memory only). TTL and external store **Planned**. |
| **Model client** | `AnthropicModelClient` with adaptive thinking, explicit effort, server-side refusal fallback. | **Built**, never run against the real API. OpenRouter **Planned**. |
| **Tools and permissions** | A tool registry with Zod-validated inputs, and per-Node tool allow-lists. | **Planned** (needed by verify). |
| **Guards** | Named, code-enforced rules on Edges, tools and replies. | **Partly built** (Edge and reply guards for refusals, empty replies and End states). The verify guards are **Planned** (§8.3). |
| **Traces** | A structured record per Turn: hops, latency, tokens, stop reasons, Edges taken, Guard decisions. | **Planned** (§8.4). Nothing logs today. |
| **Evaluation harness** | Scenario suites, a simulated Caller, a grader, a regression gate. | Offline scripted suites **built**. The rest **Planned** (§8.5). |
| **Channels** | Adapters that turn a channel event into `start()` / `handleUser()`. | Terminal chat **built**. A spoken Call in the terminal **built** (§8.6 Option C: `src/adapters/talk.ts`, with an ElevenLabs Voice in `src/voice/`), never run against the real ElevenLabs API. HTTP and Telnyx **Planned** (§8.6). |

### 4.2 Agent framework (Claude SDK)
- Package: **`@anthropic-ai/sdk`** (TypeScript). The Messages API with tool use is the agent loop, and the harness owns everything around it. The SDK is called through `client.beta.messages.stream` because the refusal-fallback beta lives there.
- **Who owns the harness is a decision, still open (§15, Q1).** The **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) is Anthropic's packaged harness for Claude Code: its own loop, built-in filesystem and shell tools, a subprocess runtime. **Current decision:** keep our own harness on `@anthropic-ai/sdk`, because a per-Turn voice loop needs tight control over latency, context and Guards that a general coding harness does not give. **Planned:** the only seam today is `ModelClient`, which covers one model call, not a Node's whole agent loop. Letting the Agent SDK run a specific Node later would need a new seam at `runNode`, and nothing in the Flow data would change.
- Edges are exposed to the model as tools named `transition__<edge_id>`, and the Edge's `condition.prompt` is the tool description.
- Forced `tool_choice` (`any`/`tool`) returns a 400 on Sonnet 5.5, so the engine uses `tool_choice: auto`, `strict: true` tool schemas and prompt-level steering.

### 4.3 Models
| Item | Decision |
|---|---|
| Default model | `claude-sonnet-5-5` (Sonnet 5.5), set once in `default_model` |
| Per-node override | Node field `model`. Format `anthropic/<id>` (default provider) or `openrouter/<vendor>/<model>`. |
| Thinking | Default: `thinking: { type: "adaptive" }` at `effort: "low"` (the migration guide's first recommendation). `{type:"disabled"}` is a 400 on Sonnet 5.5. Option to benchmark at M3 for lower latency: per-node `thinking: "between_tools"` (no extended thinking, effort `high` or below). |
| Effort | Set per Node via the static, top-level `output_config.effort` (default `low`). **Never change effort mid-conversation with per-message effort**: it is a 400 under `between_tools`, and changing top-level effort invalidates the prompt cache. Node-level effort is fine because each Node has its own system prompt anyway. |
| Thinking blocks | Pass `thinking` blocks back unchanged inside a single Turn's tool loop. They are bound to the model and conversation (history-editing check), so the engine does not replay them across Turns. `session.transcript` stays plain text, and Nodes with different system prompts never share thinking blocks. |
| Sampling params | Do not send `temperature`, `top_p` or `top_k`. Non-default values are rejected on Sonnet 5.5. |
| Prefill | Not supported. Steer through the system prompt. |
| Output length | `max_tokens` is 1024. Adaptive thinking counts toward `max_tokens` even though it is not returned, so a small cap such as 300 can cut a reply off after a long think. Replies are spoken aloud, so 1–3 short sentences with no markdown, enforced by the Flow's instructions rather than by the cap. |
| Refusals | Always check `stop_reason` before reading `content`. Enable server-side fallback (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`) on Anthropic-provider calls. It only retries `cyber` and `frontier_llm` declines. `bio`, `reasoning_extraction` and `general_harms` refusals are not retried, so the engine must handle any `stop_reason: "refusal"` by speaking a safe line and staying on the current node. With `between_tools`, a fallback to Sonnet 5 runs with thinking disabled. |
| Model-specific flags | Thinking, effort and fallback options are Anthropic-only. The router strips them for OpenRouter models. |

### 4.4 OpenRouter (optional provider)
- Enabled only if `OPENROUTER_API_KEY` is set. It works with just `ANTHROPIC_API_KEY`.
- Integration: OpenRouter exposes an Anthropic-compatible endpoint, so the same SDK client can be constructed with `baseURL: "https://openrouter.ai/api"` and the OpenRouter key. **Verify against current OpenRouter docs before building**, including tool-use and streaming parity for non-Claude models. If parity is poor, fall back to OpenRouter's OpenAI-compatible endpoint behind the same `ModelClient` interface.
- Nodes that name an `openrouter/...` model fail at flow-load time if the key is missing. This is a clear error, not a runtime surprise.
- Known limits: no Anthropic server-side refusal fallback, no `between_tools` thinking and no effort control on non-Claude models. The router logs which options it dropped.

## 5. Flow definition

A flow is one JSON file validated with Zod at load time. Top-level fields: `base_instructions`, `default_model`, `variables`, `start_node`, `nodes`, `edges`, `end_states` (a map of name to `{ message }`).

### 5.1 Node (only type `prompt` so far)
| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique. |
| `type` | `"prompt"` | `speak` and `tool` node types are reserved for later. |
| `instructions` | string | Supports `{{var}}` templating. |
| `model` | string? | Overrides `default_model`. |
| `effort` | `low`…`max`? | Anthropic models only. |
| `tools` | string[] | Names from the tool registry that the model may call on this node. |
| `max_tool_rounds` | number | Default 3. Guards against tool loops. |

### 5.2 Edge
| Field | Notes |
|---|---|
| `id`, `from`, `to` | `to` is a node id or an `end_states` key. Entering an end state speaks its `message` and ends the Call. |
| `condition.type` | `"llm"` today (becomes a `transition__<id>` tool). `"expression"` is reserved, so deterministic transitions can later skip the model call. |
| `condition.prompt` | Tells the model when to take the edge. |

### 5.3 Engine semantics (carried over from the existing design notes)
- A transition tool call re-runs the **target node on the same utterance**. Text already spoken this turn is injected into the next node's system prompt so it does not repeat the greeting.
- Transition wins over business tool calls made in the same response.
- `max_hops` per caller utterance (default 4) guards against routing loops.
- `Session.transcript` stores plain-text turns only. Facts that must persist across turns go into `session.variables`.
- Every handled utterance must be idempotent on a `turnId`, so a webhook retry never re-runs tools or duplicates the transcript.

### 5.4 Target Flow with verify

The built Flow (`flows/receptionist.json`) has only the `start` Node and the `goodbye` End state. This is the target once the verify Node exists (M5). It keeps everything already built (the `goodbye` End state and Edge, the Flow variables, the no-farewell rule) and adds verify. Lines marked `// built` already exist.

```jsonc
{
  "base_instructions": "You are {{receptionist_name}}, the virtual receptionist for {{company_name}}. Your replies are spoken aloud, so keep them to 1 to 3 short sentences with no markdown, lists or emojis.",
  "default_model": "anthropic/claude-sonnet-5-5",
  "variables": { "receptionist_name": "Ava", "company_name": "Acme Co." },
  "start_node": "start",
  "end_states": {
    "goodbye":  { "message": "Thank you for calling. Goodbye." },                       // built
    "verified": { "message": "Thanks {{customer_first_name}}, you're verified. One moment while I get you to the right place." },
    "failed":   { "message": "I'm sorry, I wasn't able to verify your identity, so I can't continue with this request. Please try again later or contact us directly. Goodbye." }
  },
  "nodes": [
    {
      "id": "start", "type": "prompt", "model": "anthropic/claude-sonnet-5-5", "effort": "low", "tools": [],
      // The built instructions (see flows/receptionist.json) say the Receptionist cannot act on requests yet.
      // With verify, they change to: greet, learn why the Caller is calling, and take e_start_verify once
      // there is a stated need. They must keep the built rule: take an End state Edge without a farewell
      // of its own, because the system speaks the closing message (otherwise the Caller hears two goodbyes).
      "instructions": "Greet the caller warmly, say your name and company, and ask how you can help. Do not ask for personal details yet. ... When the caller says goodbye or needs nothing else, take the goodbye transition without a farewell of your own."
    },
    {
      "id": "verify", "type": "prompt", "model": "anthropic/claude-sonnet-5-5", "effort": "low", "tools": ["verify_identity"],
      "instructions": "The caller must be verified before anything else. Ask for their customer ID and date of birth, one at a time if needed. Call verify_identity once you have both. Never state which detail was wrong. Never read back stored data. If the caller wants to end the call, take the goodbye transition without a farewell of your own."
    }
  ],
  "edges": [
    { "id": "e_start_goodbye", "from": "start", "to": "goodbye",                            // built
      "condition": { "type": "llm", "prompt": "The caller says they need nothing else, wants to end the call, or says goodbye." } },
    { "id": "e_start_verify", "from": "start", "to": "verify",
      "condition": { "type": "llm", "prompt": "The caller has said why they are calling or what they need." } },
    { "id": "e_verify_goodbye", "from": "verify", "to": "goodbye",
      "condition": { "type": "llm", "prompt": "The caller wants to end the call or says goodbye." } },
    { "id": "e_verify_ok", "from": "verify", "to": "verified",
      "condition": { "type": "llm", "prompt": "verify_identity returned verified=true." } },
    { "id": "e_verify_fail", "from": "verify", "to": "failed",
      "condition": { "type": "llm", "prompt": "verify_identity returned locked=true, or the caller refuses to verify." } }
  ]
}
```

> **Guards (engine-enforced, both directions; Planned with verify, see §8.3):**
> - **Success:** transitioning to `verified` is only allowed if `session.variables.verified === true`, which only the `verify_identity` handler can set. If the model calls `e_verify_ok` without it, the engine rejects the edge and keeps the caller on `verify`. Likewise, any future node marked `requires_verified: true` can't be entered otherwise.
> - **Lockout:** when `verify_identity` returns `locked=true`, the engine forces the transition to `failed` whatever the model does or says. Lockout never depends on the model choosing `e_verify_fail`.
> - **End-state message:** on entering an end state, the engine speaks that end state's templated `message` (`end_states.<name>.message`). It is spoken after any text the model already produced this turn, and the model is not asked to say goodbye. The `customer_first_name` variable is set by `verify_identity` on success only, from the DB record, never from model output.

## 6. Verify node: identity check

### 6.1 Tool: `verify_identity`
- **Input (Zod, strict):** `{ customer_id: string, date_of_birth: string (YYYY-MM-DD) }`. The model must convert spoken dates ("March 3rd 1985") into ISO. The handler rejects anything that doesn't parse.
- **Normalisation:** customer ID goes through a function that removes spaces and hyphens, upper-cases, and converts spoken digits to numerals ("E one zero zero one" becomes `E1001`).
- **Output to the model:** only `{ verified: boolean, attempts_remaining: number, locked: boolean }`. **Never** returns stored data or says which field mismatched. Unknown ID and wrong DOB look identical, and take comparable time (constant-time compare, with a dummy lookup when the ID does not exist).
- **Side effects on success:** sets `session.variables.verified = true`, `customer_id`, and `verified_at`. The model is never given the customer's record.
- **Attempt limit:** 3 failed attempts per call, counted in code from the `verification_attempts` table. Lock out per call. Optionally also rate-limit per `customer_id` (5 failures per 15 min, any call) to resist guessing across calls.
- **Caller ID (ANI):** if `caller_number` matches the record's phone, record it as a risk signal in the attempt log. It never replaces ID + DOB.

### 6.2 SQLite schema (planned, M5)

```sql
CREATE TABLE customers (
  id            INTEGER PRIMARY KEY,
  customer_id   TEXT NOT NULL UNIQUE,      -- e.g. 'E1001'
  full_name     TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,             -- ISO 'YYYY-MM-DD'
  phone_e164    TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended'))
);

CREATE TABLE verification_attempts (
  id           INTEGER PRIMARY KEY,
  call_id      TEXT NOT NULL,
  customer_id  TEXT,                       -- as supplied, normalised; may not exist
  success      INTEGER NOT NULL CHECK (success IN (0,1)),
  ani_match    INTEGER,                    -- 1/0/NULL
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_attempts_call ON verification_attempts(call_id, created_at);
CREATE INDEX idx_attempts_cust ON verification_attempts(customer_id, created_at);
```

- Library: `better-sqlite3` (synchronous, fast, no server). The DB file lives at `data/receptionist.db`, which is git-ignored. The seed script `npm run db:seed` loads 5–10 fake customers, including one `suspended`.
- All queries are **parameterised**. No string-built SQL anywhere.
- SQLite has no per-table grants. Customer reads go through a `readonly: true` connection, and `recordAttempt` in `db/repo.ts` is the only code path that opens a writable connection or writes to `verification_attempts`. No tool handler touches the DB directly.
- **Data handling:** the DOB is PII. It must not appear in logs or transcripts persisted outside the call. Logging redacts tool inputs for `verify_identity`. The model sees DOB in the conversation (it must, to pass it to the tool), so it must be kept out of any third-party logging.
- **Migration path:** repository functions (`findCustomer`, `recordAttempt`, `countRecentFailures`) hide SQLite, so swapping to Postgres or Aurora later only touches `db/`.

## 7. Engine behaviour and interfaces

```ts
interface TurnResult {
  reply: string;                  // text to speak or display (includes the End state message when ended)
  nodeId: string;                 // Node (or End state) after this Turn
  ended: boolean;                 // true when an End state is reached
  endState?: string;              // e.g. "goodbye" (built); "verified" | "failed" once verify exists
  actions: Action[];              // reserved: transfer, hangup (always empty today)
}

interface FlowEngine {
  start(callId: string, ctx: { callerNumber?: string }, stream?: ReplyStream): Promise<TurnResult>;
  handleUser(callId: string, utterance: string, turnId: string, stream?: ReplyStream): Promise<TurnResult>;
}

interface ModelClient {           // AnthropicModelClient (built), an OpenRouter client (planned), FakeClaude in tests
  createMessage(req: ModelRequest, onTextDelta?: (delta: string) => void): Promise<ModelResponse>;
}

interface SessionStore {          // in-memory today; the seam for Redis or DynamoDB
  get(callId: string): Promise<Session | undefined>;
  put(session: Session): Promise<void>;
  delete(callId: string): Promise<void>;
}
```

- A Call opens with `start()`, which runs the `start` Node with no Caller utterance and returns the greeting.
- Empty replies are never returned. If the model returns nothing usable, the engine substitutes a safe line. **This does not apply when the Turn reached an End state**, because the End state's `message` is the reply. A refusal (`stop_reason: "refusal"`) gets a safe spoken line and leaves the Call on the current Node. `start()` does the same for a refused or empty greeting.
- Calls end when an End state is reached. A TTL for abandoned Calls (default 30 min) is **Planned**.
- Errors from a model provider leave the Call untouched so the same `turnId` can be retried. A spoken apology on a provider error is **Planned**. Retry (SDK default) covers transient 429/5xx.
- `ModelResponse` will carry token usage and timings once Traces exist (§8.4). It does not today.

## 8. Harness capabilities

### 8.1 Invariants

These must hold whatever the model outputs. Each has an owner in code and a test.

| # | Invariant | Status |
|---|---|---|
| I1 | The model never decides identity. Only `verify_identity` can set `verified`, and only the engine applies an Edge into a verified-only Node or End state. | **Planned** with verify |
| I2 | An Edge is applied by the engine, never by the model, and never from a refused response. | **Built** |
| I3 | An empty reply is never spoken. | **Built** |
| I4 | Refused text is never stored as the Receptionist's words, and a refused Turn is never replayed to the model. | **Built** |
| I5 | A Turn is idempotent on `turnId` and Turns on one Call run one at a time. | **Built** |
| I6 | What a stream was shown equals the Turn's final reply, or is discarded first. | **Built** |
| I7 | Requests never carry sampling parameters, a disabled thinking mode, prefill or forced tool choice, and always set effort. | **Built** |
| I8 | A lockout forces the `failed` End state whatever the model does. | **Planned** with verify |
| I9 | Tool inputs are validated against their schema before a tool runs. An invalid input produces an error result for the model, not an execution. | **Planned** with the tool registry |
| I10 | PII never reaches a Trace or log in clear text. | **Planned** with Traces |

### 8.2 Context assembly

What enters each model request is a design decision, not an accident.

- **Built:**
  - The system prompt is `base_instructions`, then the Node's rendered instructions, then any text already said this Turn (so a new Node does not greet again).
  - Messages are the plain-text transcript only, with refused and empty entries left out.
  - Thinking and tool calls are never replayed across Turns, and each Node starts from its own system prompt and tools. This avoids the history-editing check on thinking blocks.
- **Planned:**
  - **Prompt caching.** `base_instructions` and each Node's instructions are the stable prefix. Sonnet 5.5 only caches prefixes above a minimum size, so short prompts will not cache. Measure `cache_read_input_tokens` in Traces before relying on it, and add `cache_control` only where it pays.
  - **Long Calls.** A cap on transcript length and a rule for what survives it. `session.variables` always survives, because facts that must persist live there and not in the transcript.
  - **Variable exposure.** An explicit allow-list of which `session.variables` the model is shown. `customer_id` may be shown. Stored records never are.

### 8.3 Guards

A **Guard** is a named, code-enforced rule that runs at a fixed point in the Turn. Guards are what turns "the prompt says not to" into "it cannot happen".

| Guard point | Example | Status |
|---|---|---|
| **Edge guard**, before an Edge is applied | `e_verify_ok` needs `session.variables.verified === true`. If not, reject and keep the Caller on the Node. | **Planned** |
| **Forced Edge**, after a tool result | `locked=true` forces `failed` regardless of the model. | **Planned** |
| **Tool guard**, before a tool runs | The tool is on this Node's allow-list, and its input passes the schema. | **Planned** |
| **Reply guard**, after the model replies | Never empty, never a refusal's text, an End state's message is spoken once. | **Built** (basic). Spoken-form rules such as no markdown and a length cap are **Planned**. |
| **Data guard**, before anything is recorded | PII fields are redacted from Traces. | **Planned** |

- Guards are named functions in code. The Flow references them by name (for example an Edge's `guard: "verified"` or a Node's `requires_verified`), so authors choose where they apply but cannot weaken what they do.
- A rejected Edge counts as a hop. The engine tells the model why in a tool result so it can recover (for example by asking for the missing detail), and the decision is recorded in the Trace.
- Every Guard decision, allowed or rejected, appears in the Trace with the Guard's name.

### 8.4 Traces

A **Trace** is the structured record of how the harness handled one Turn. It is the single source for debugging, measuring and evaluating.

Fields (one record per Turn, plus one per Call start):

```ts
interface TurnTrace {
  callId: string; turnId: string; at: string;          // ISO timestamp
  callerUtterance: string;                              // redacted per policy
  hops: Array<{
    nodeId: string; model: string; effort: string;
    latencyMs: number; firstTokenMs?: number;
    inputTokens: number; outputTokens: number; cacheReadTokens?: number;
    stopReason: string;
    toolsCalled: string[]; edgeProposed?: string; edgeApplied?: string;
    guardDecisions: Array<{ guard: string; allowed: boolean; reason?: string }>;
  }>;
  reply: string; endState?: string;
  safeLineUsed?: "empty" | "refusal" | "error";
}
```

- Written through a `TraceSink` interface. First sink: one JSONL file per Call under `traces/` (git-ignored). The same interface later feeds a log service.
- Requires `ModelResponse` to carry usage and timings, which it does not yet.
- **Redaction is done at write time.** `verify_identity` inputs, dates of birth and customer records are never written in clear. Traces still contain what the Caller said, so they stay local and are treated as sensitive.
- Derived metrics: first-token latency, Turn latency, hops per Turn (the main cause of dead air), tokens and cost per Call, refusal rate, Guard rejections, safe-line rate.
- Traces are replayable: a recorded Call with its recorded model responses can be re-run through the engine for a deterministic engine regression test (§12, tier 2).

### 8.5 Evaluation harness

The harness measures itself. Three tiers, cheapest first.

| Tier | What it does | Cost | Status |
|---|---|---|---|
| **1. Offline scripted** | `FakeClaude` returns scripted model responses and tests assert on the engine's behaviour. | Free | **Built** (the offline suite in `test/`) |
| **2. Trace replay** | Re-runs a recorded Call with its recorded model responses to catch engine regressions deterministically. | Free | **Planned** (needs Traces) |
| **3. Live Scenarios** | A simulated Caller talks to the Receptionist on the real model, and the result is checked and graded. | Money | **Planned** |

**Scenario** (a JSON file): a persona and goal for the simulated Caller, the facts the Caller knows, and what must be true afterwards.

```jsonc
{
  "id": "wrong-dob-then-correct",
  "caller": { "persona": "Polite, a little hurried", "goal": "Check my leave balance",
              "knows": { "customer_id": "E1001", "date_of_birth": "1985-03-03" },
              "script_hints": ["Give the wrong birth year first, then correct it"] },
  "expect": {
    "endState": "verified",
    "variables": { "verified": true },
    "maxTurns": 8, "maxHopsPerTurn": 3,
    "mustNotSay": ["wrong date", "does not match"],
    "guardsFired": [],
    "replyRules": ["no markdown", "at most 3 sentences per reply"]
  },
  "rubric": ["Never reveals which detail was wrong", "Stays polite and brief", "Asks for one detail at a time"]
}
```

- **Simulated Caller.** A model plays the Caller, given only what a real Caller would know. It never sees the Flow's instructions. Default: `claude-haiku-5-5` (cheap), configurable per Scenario.
- **Two kinds of check.** Hard assertions in code (End state, variables, hops, banned phrases, Guards fired, reply rules) and a rubric graded by an LLM judge using structured output. A stronger model than the Receptionist is preferred for the judge (default to confirm: `claude-opus-5-5`). Code assertions decide pass/fail. The judge adds scores and explanations.
- **Nondeterminism.** Each Scenario runs N times (default 5) and reports a pass rate, never one lucky pass.
- **Regression gate.** A baseline file stores each Scenario's pass rate, median latency and cost. A run fails if a pass rate drops by more than a set margin, a hard assertion fails on a Scenario marked critical, or a budget cap is hit.
- **Budget and consent.** Live tiers spend money. They are opt-in (`RUN_LIVE=1`), print an estimated cost before running, and stop at a configured spend cap.
- **Judge hygiene.** The rubric is versioned with the Scenario. A sample of judged runs is reviewed by a human, and disagreements are recorded.
- **Feedback loop.** A bad Trace can be promoted into a new Scenario (`npm run trace:promote <callId>`): the Caller's utterances become the script, the failure becomes an assertion, and the Scenario fails until the harness is fixed.

Acceptance: a deliberately broken Flow (for example verify with its Guard removed) must make the live Scenarios fail, and the fixed Flow must pass.

### 8.6 Voice channel (Telnyx)

Voice is the target channel. The harness already treats a channel as an adapter around `start()` and `handleUser()`. Option C is **built** as a development tool, with ElevenLabs as the **Voice** (see "Option C as built" below). Nothing for Telnyx or HTTP is built, and **the choice of first phone adapter is still open (§15, Q4).**

| Option | How it works | Trade-offs |
|---|---|---|
| **A. Telnyx TeXML webhooks** (recommended first) | Telnyx calls the server. The server returns `<Say>` and `<Gather input="speech">`, and Telnyx does speech recognition and synthesis. | Fastest to build and the engine fits as it is. One HTTP round trip per Turn, no streaming audio and no barge-in, so there is a pause between Turns. |
| **B. Real-time media streaming** | A WebSocket carries live audio. Speech recognition and synthesis are our own choice. | Natural pacing and interruptions, but much more work and cost. Comes after A. |
| **C. Local microphone and speaker** (**built**, with ElevenLabs) | Talk to the harness from a laptop with no phone line. | Useful for tuning the voice before spending on telephony. Optional. |

Requirements for Option A:
- An HTTP server with one endpoint per TeXML event: inbound call (`start()`), speech gathered (`handleUser()`), no input, and a status callback that removes the Call's state.
- Webhook signature verification before any webhook is processed.
- Each webhook carries its own id, which becomes the `turnId`, so retries are idempotent (already supported by the engine).
- A speech-to-text normaliser for spoken digits, spelled letters and dates, shared with the verify tool.
- A per-Turn latency budget (target: reply spoken within about 3 s p50 including an Edge hop), measured in Traces. If hops make dead air unacceptable, add a short spoken acknowledgement while the Turn runs.
- Things to verify against Telnyx's docs before building, because they were noted as unverified: bare-number `<Dial>`, `speechTimeout` units, and whether `<Say>` accepts language and voice attributes.

Option C as built (`npm run talk`, #8):

- **What it is.** A spoken Call in the terminal. `src/adapters/talk.ts` (`runTalk`) is the adapter, and the engine is unchanged. The **Voice** is an interface (`src/voice/voice.ts`: `speak(text)` and `listen()`), and `ElevenLabsVoice` is the only real one. It calls ElevenLabs' text-to-speech and speech-to-text endpoints with plain `fetch`, plays the mp3 with macOS `afplay` and records the microphone with `ffmpeg`. There is no new dependency. ElevenLabs is not a tool the model can call, and this is not the ElevenLabs Agents platform.
- **Speaking.** Only the Turn's final reply is spoken (`TurnResult.reply`, which includes an End state's message), once, after the Turn has finished. Nothing is spoken while text streams, because a stream may still be discarded (I6) and speech cannot be unspoken. The text is always printed as well.
- **Listening.** Push-to-talk: Enter starts a recording and Enter stops it, then the clip is transcribed. A typed line is still accepted at the prompt.
- **Failures stay in the adapter.** An empty or failed transcript is answered by the adapter, which asks again, so only non-empty text reaches `handleUser()`. A failure to speak prints one line and the Call carries on: it never changes the Turn's result, never ends the Call and is never fed to the model. These are adapter rules with their own offline tests, not numbered invariants (§8.1).
- **Configuration.** `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`, plus optional model and host variables (§10). They live in `.env`, not in the Flow.
- **Timing.** After each Turn the adapter prints one line saying how long recording, transcribing, the model and speaking took, in ms. It is plain terminal output, not a Trace (§8.4). `speak` includes playing the whole reply, so it grows with the reply's length, and nothing measures when the reply starts to be heard. The line is therefore not a measurement of the latency target above.
- **Never run for real.** `ElevenLabsVoice` is tested against canned HTTP, and `npm run talk` against stand-ins for both APIs, `afplay` and `ffmpeg`. Neither has run against the real ElevenLabs API, the opt-in live Voice check (`test/live-voice.test.ts`) has never run, and no spoken Call has been held.
- **Not built.** Telnyx, an HTTP server, barge-in, silence detection, real-time audio streaming, speaking while text streams, and playback or recording on Windows or Linux.

## 9. Project layout

Built:

```
receptionist/
├── PRD.md  CLAUDE.md  GLOSSARY.md  docs/agents/
├── package.json            # type: module, Node 24+; scripts: chat, talk, test, test:live, typecheck
├── tsconfig.json           # strict
├── .env.example
├── flows/receptionist.json
├── src/
│   ├── config.ts
│   ├── flow/               # schema.ts (Zod + cross-reference checks), load.ts
│   ├── engine/             # engine.ts, run-node.ts, model.ts, anthropic-client.ts,
│   │                       # reply-stream.ts, session.ts, templating.ts, turn.ts
│   ├── voice/              # voice.ts (the Voice interface), elevenlabs.ts,
│   │                       # player.ts (afplay), recorder.ts (ffmpeg), wav.ts
│   └── adapters/           # chat.ts, cli.ts, terminal-reply.ts (terminal chat);
│                           # talk.ts, talk-terminal.ts, talk-cli.ts, line-queue.ts (spoken Call)
└── test/                   # vitest, offline; fake-claude.ts, fake-voice.ts, fake-ffmpeg.ts, sse.ts, wav.ts,
                            # live.test.ts and live-voice.test.ts (opt-in)
```

Planned additions: `src/tools/` (registry, `verify-identity.ts`, `normalise.ts`), `src/guards/`, `src/db/` (connection, `schema.sql`, `seed.ts`, `repo.ts`), `src/trace/` (`TraceSink`, redaction), `src/eval/` (scenario runner, simulated Caller, judge, gate), `src/adapters/http.ts` and `texml.ts`, `scenarios/`, `traces/` (git-ignored), `data/` (git-ignored).

Stack: Node 24+, TypeScript (strict), `@anthropic-ai/sdk`, `zod`, `vitest`, `tsx`. A spoken Call (`npm run talk`) also needs macOS for `afplay`, and `ffmpeg` installed. Neither is an npm dependency, and ElevenLabs is called with plain `fetch`. Planned: `better-sqlite3`, an HTTP framework (Hono or Fastify, decide at the voice milestone).

## 10. Configuration

| Variable | Required | Status | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Built | Anthropic provider (Sonnet 5.5). |
| `FLOW_PATH` | No | Built | Flow file. Defaults to `flows/receptionist.json`. |
| `ELEVENLABS_API_KEY` | For `npm run talk` only | Built | ElevenLabs key for the Voice: speech out and speech in. |
| `ELEVENLABS_VOICE_ID` | For `npm run talk` only | Built | The ElevenLabs voice the Receptionist speaks with. |
| `ELEVENLABS_MODEL_ID` | No | Built | Text-to-speech model. Defaults to `eleven_flash_v2_5`. |
| `ELEVENLABS_STT_MODEL_ID` | No | Built | Speech-to-text model. Defaults to `scribe_v2`. |
| `ELEVENLABS_BASE_URL` | No | Built | ElevenLabs API host. Defaults to `https://api.elevenlabs.io`. |
| `OPENROUTER_API_KEY` | No | Planned | Enables `openrouter/...` models. |
| `DB_PATH` | No | Planned | Defaults to `./data/receptionist.db`. |
| `TRACE_DIR` | No | Planned | Defaults to `./traces`. |
| `MAX_HOPS`, `SESSION_TTL_SECS` | No | Planned | Engine guards. `maxHops` is an engine option today. |
| `EVAL_SPEND_CAP_USD` | No | Planned | Stops a live evaluation run. |

Never commit keys. The Flow file never contains secrets.

## 11. Requirements

### Functional
- FR1. Load and validate a Flow file. Reject unknown Node/Edge references, unreachable Nodes, missing models and unknown tools at startup. **Built** (the model check is format-only).
- FR2. `start()` returns a greeting from the start Node. **Built**
- FR3. The start Node moves to verify on the Caller's first stated need, in the same Turn, without re-greeting. **Planned** with verify. The same-Turn Edge mechanism is **Built**.
- FR4. `verify_identity` returns pass/fail per §6.1, with the attempt limit enforced in code. **Planned**
- FR5. Entering the `verified` End state requires `session.variables.verified === true` (engine-enforced). **Planned**
- FR6. Per-Node `model` override works for both `anthropic/` and `openrouter/` models. `anthropic/` **Built**. `openrouter/` **Planned**.
- FR7. A terminal chat (**Built**), a spoken Call in the terminal (**Built**, §8.6 Option C) and an HTTP interface for the voice adapter (**Planned**).
- FR8. Every Turn is idempotent on `turnId`. **Built**
- FR9. Every Turn writes a Trace per §8.4, with PII redacted. **Planned**
- FR10. Guards per §8.3 are enforced and every decision appears in the Trace. **Planned**
- FR11. Scenarios, a simulated Caller, a judge and a regression gate per §8.5. **Planned**
- FR12. A Telnyx voice adapter per §8.6. **Planned**

### Non-functional
- NFR1. Latency: a single-Node Turn with no tool call should reach first reply token in under ~1.5 s p50 (streaming, terminal). A Turn with an Edge hop (two model calls) is tracked as its own metric, since it is the main source of dead air. Measured from Traces.
- NFR2. All behaviour is testable offline with a fake `ModelClient`. No network in unit tests. **Built**
- NFR3. Structured JSON Traces per Turn (§8.4). PII redacted.
- NFR4. TypeScript strict mode, no `any` in `src/engine`.
- NFR5. Evaluation is reproducible: Scenarios, rubrics, judge model and the harness version are recorded with every result.
- NFR6. A live evaluation run never spends more than its configured cap.

## 12. Testing strategy

- **Tier 1, offline scripted (built).** `FakeClaude` returns scripted content blocks and records request arguments (model, tools, system prompt). Copy `messages` when snapshotting, since the engine mutates the array. It covers routing, End states, refusals, idempotency and the streaming rule. `test/sse.ts` builds canned HTTP streams so the real Anthropic client is exercised without a network.
- **Guard tests (planned).** A model that forges `e_verify_ok` without a pass is rejected. A lockout forces `failed`. A tool call off a Node's allow-list is refused. A tool input that fails its schema never runs.
- **Verify tests (planned).** Success, wrong DOB, unknown ID (identical response), 3-strike lockout, spoken-digit normalisation, suspended account, tool output never contains customer data.
- **DB tests (planned).** In-memory SQLite (`:memory:`) per test, seeded fixtures.
- **Tier 2, Trace replay (planned).** Deterministic engine regression from recorded Calls.
- **Tier 3, live Scenarios (planned).** Per §8.5, opt-in, capped.
- **Live smoke test (built, never run).** `test/live.test.ts`, gated behind `RUN_LIVE=1`, asserts facts that hold every run (name, no markdown, closing message once, stream equals reply).
- **Voice tests (built).** `FakeVoice` scripts what is heard and records what is spoken, and covers the spoken Call's loop with `FakeClaude`. `ElevenLabsVoice` is exercised against canned HTTP responses with an injected player and recorder, and the recorder against a stand-in for `ffmpeg`. `npm run talk` is run as a whole program against a local server that stands in for Anthropic and ElevenLabs, with stand-ins for `afplay` and `ffmpeg`. No sound is played and no microphone is opened.
- **Live Voice check (built, never run).** `test/live-voice.test.ts`, behind the same `RUN_LIVE=1` gate (`npm run test:live` runs both live files). One sentence is spoken to a player that keeps the mp3 instead of playing it, and that mp3 is then transcribed. An offline test proves that `npm test` skips it and that it stops on the missing-key message when there is no key.

## 13. Milestones

| M | Deliverable | Done when | Status |
|---|---|---|---|
| M0 | Scaffold, Flow schema and loader (#1) | Typecheck passes and the sample Flow validates | **Done** |
| M1 | Engine, `FakeClaude`, greeting, Turns, goodbye End state (#2–#4) | S1, S8, S9 and S11 pass offline | **Done** |
| M2 | Anthropic client, terminal chat, `CLAUDE.md` (#5, #6) | Works against canned streams | **Done** (live path not yet run) |
| — | **Spoken Call in the terminal** (#8, §8.6 Option C, outside the numbered plan): the `Voice` interface, an ElevenLabs Voice, push-to-talk, `npm run talk` | Works against canned HTTP and stand-ins for `afplay` and `ffmpeg` | **Done** (live path not yet run, no spoken Call held) |
| M3 | **First live run.** Run `npm run chat` and `npm run test:live` with a real key, fix what breaks, and time each Turn by hand | A real conversation works, and the fallback beta and streaming behave | Next |
| M4 | **Traces.** `ModelResponse` usage and timings, `TraceSink`, JSONL sink, redaction | Every Turn writes a valid Trace and latency per hop is visible | Planned |
| M5 | **Tool registry, Guards, SQLite, verify Node** | S2–S7 and S10 pass offline, invariants I1, I8 and I9 hold | Planned |
| M6 | **Evaluation harness.** Scenario format, simulated Caller, judge, regression gate, Trace promotion | A broken Flow fails the live Scenarios and the fixed Flow passes | Planned |
| M7 | **Voice adapter (Option A).** HTTP server, TeXML events, signature verification, status callback, STT normaliser | A real phone call reaches the Receptionist and completes the verify Flow | Planned |
| M8 | OpenRouter provider and per-Node override | One Node runs an OpenRouter model, and a missing key is a load-time error | Planned |
| M9 | Hardening: TTL sweeper, external Call-state store, prompt caching measured, Option B if latency demands it | NFR1 met on a real line | Planned |

## 14. Risks

| Risk | Mitigation |
|---|---|
| LLM claims verification without a tool pass | Engine-enforced Guards (I1, I8). The tool is the only writer of the flag. |
| Identity data leaked to the Caller, Traces or logs | Minimal tool output, redaction at write time, no stored-data readback, Traces kept local. |
| Weak verification factors (ID + DOB are guessable or known to others) | Attempt limits, per-ID rate limit, ANI signal. Add a PIN or one-time code before exposing sensitive data. |
| Speech-to-text mangles IDs and dates | Normalisation layer, a confirm-back step for the ID, then a DOB re-ask. |
| 2+ sequential model calls per Edge cause dead air | Trace per-hop latency, add deterministic `expression` Edges, stream the first Node's text while the next runs, spoken acknowledgement. |
| The live Anthropic path has never run | M3 comes before anything else is built on it. |
| The ElevenLabs path has never run, and no spoken Call has been held | Run the live Voice check and hold a spoken Call by hand before relying on the Voice. The text is always printed, so a Voice failure costs one line and does not stop a Call. |
| Evaluation is flaky or expensive | N runs per Scenario with pass rates, cheap simulated Caller, spend cap, opt-in only. |
| LLM judge is biased or drifts | Code assertions decide pass/fail, the judge only scores, rubrics are versioned, humans sample judged runs. |
| Simulated Caller is unrealistically cooperative | Personas with awkward behaviour, scripted hints, and promoting real failed Calls into Scenarios. |
| Traces become a PII store | Redaction at write time, local-only by default, a retention rule before any remote sink. |
| Harness complexity grows faster than value | Each layer needs an invariant or a metric it protects. Anything that protects neither is cut. |
| OpenRouter parity with Anthropic tool use for non-Claude models | Verify before M8. Keep the `ModelClient` abstraction and an OpenAI-compatible fallback. |
| Sonnet 5.5 API specifics change (thinking, effort, tool choice) | Isolate request building in `anthropic-client.ts`. Pin the SDK version. |
| In-memory sessions lost on restart and break with multiple workers | Acceptable until the voice adapter. `SessionStore` is the seam for Redis or DynamoDB. |

## 15. Open questions

1. **Who owns the harness?** Current decision: our own harness on `@anthropic-ai/sdk`, for per-Turn latency and control (§4.2). The Claude Agent SDK is Anthropic's packaged harness and could run a specific Node later behind an interface. Confirm this stays the decision.
2. **Verification factors:** Are customer ID + DOB acceptable, or should the first release use name + DOB, phone number lookup, or a PIN?
3. **Failure handling:** After lockout, should `failed` hang up, transfer to a human, or hand off to a callback Node?
4. **First voice adapter:** Option A (TeXML webhooks, recommended), B (media streaming) or C (local microphone)? Not yet chosen. Option C now exists as a development tool (§8.6), which does not answer this: no phone adapter is chosen.
5. **HTTP framework:** Hono or Fastify?
6. **Caller identity by ANI:** should a matching caller number ever lower the bar, or stay signal-only?
7. **Evaluation models and budget:** are `claude-haiku-5-5` for the simulated Caller and `claude-opus-5-5` for the judge acceptable, and what spend cap per run?
8. **Trace storage:** local JSONL only for now, or a remote sink, and what retention rule?
9. **Latency target on a phone line:** is about 3 s p50 per Turn acceptable for Option A, or is barge-in (Option B) required for launch?

## 16. Later (out of scope now)

`speak` and `tool` Node types, `expression` Edges, post-verification business Nodes (account lookup, transfer), an external Call-state store, AWS deployment, multi-tenant support, and a visual Flow editor.
