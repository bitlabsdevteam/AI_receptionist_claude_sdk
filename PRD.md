# PRD: AI Assistant Workflow Engine (Telnyx-style)

| | |
|---|---|
| **Status** | Draft v0.1 |
| **Date** | 2026-11-14 |
| **Language / runtime** | TypeScript on Node.js 22+ |
| **Phase 1 scope** | Two nodes: `start` (greet) and `verify` (identity check against SQLite) |

---

## 1. Summary

Build a conversation-flow engine like Telnyx AI Assistant workflows. A call or chat is a graph of **nodes**. Each node has its own instructions, tools, model and outgoing **edges**. The engine runs one node at a time, takes the caller's utterance, decides whether to stay or move along an edge, and replies.

The agent runtime is built on Anthropic's Claude TypeScript SDK. Sonnet 5.5 (`claude-sonnet-5-5`) is the default model. OpenRouter is an optional provider, so any node can run a different model.

Phase 1 ships exactly two nodes:

1. **Start node** greets the caller and finds out why they are calling.
2. **Verify node** verifies the caller's identity against a SQLite database before anything else happens.

The flow is data (JSON), and the engine interprets it. Later phases add nodes by editing the flow file, not the engine.

## 2. Goals and non-goals

### Goals
- G1. A flow-as-data engine. Adding or changing a node should need no engine code change.
- G2. Per-node model selection. Sonnet 5.5 is the default, and any node can switch to an OpenRouter model.
- G3. The verify node checks identity against SQLite. The pass/fail decision is made by code, never by the LLM.
- G4. The engine is testable offline with a scripted fake model client.
- G5. A text channel (CLI, then HTTP) comes first. The engine knows nothing about telephony, so a voice adapter can be added later.

### Non-goals (Phase 1)
- Telephony, STT/TTS and Telnyx TeXML/webhooks. They are a later adapter that sits on top of the same `engine.handleUser()` call.
- A visual flow builder UI.
- Business nodes after verification (leave balance, invoices, transfers and so on).
- A production database, an external session store and AWS deployment. SQLite and in-memory sessions are deliberate stand-ins.
- Multi-tenant support and auth for the engine's own API.

## 3. Users and scenarios

- **Caller** reaches the assistant by voice (later) or text now. They expect a short greeting, a simple identity check, then help.
- **Flow author (developer)** edits `flows/*.json` and the SQLite seed data, and runs the flow in the CLI.

### Core scenarios
| # | Scenario | Expected result |
|---|---|---|
| S1 | Caller says "hi" | Start node greets, asks how it can help. Does not move on yet. |
| S2 | Caller states a reason ("I want to check my balance") | Start moves to Verify **on the same utterance**. The assistant does not re-greet and asks for verification details. |
| S3 | Caller gives valid ID + DOB | Verified. The session records `verified=true` and `customer_id`. The flow reaches the `verified` end state. |
| S4 | Caller gives wrong details | Generic "I couldn't verify that" with a retry. Nothing reveals which field was wrong. |
| S5 | 3 failed attempts | Lockout. The flow reaches the `failed` end state. |
| S6 | Caller refuses to verify | Verify moves to the `failed` end state with a polite close. |
| S7 | Caller speaks digits as words ("one zero zero one") | Normalised before lookup. |

## 4. Architecture

```
 Channel adapters                Engine                          Services
┌──────────────┐        ┌──────────────────────┐       ┌────────────────────┐
│ CLI (P1)     │        │ FlowEngine           │       │ ModelRouter        │
│ HTTP (P1)    │──utt──▶│  - Session           │──────▶│  - Anthropic SDK   │
│ Telnyx (later)│◀─reply─│  - advance() loop    │       │  - OpenRouter      │
└──────────────┘        │  - edge resolution   │       └────────────────────┘
                        │  - tool dispatch     │       ┌────────────────────┐
                        └─────────┬────────────┘──────▶│ Tool registry      │
                                  │                    │  verify_identity   │
                         flow.json (nodes, edges)      └─────────┬──────────┘
                                                                 │
                                                       ┌─────────▼──────────┐
                                                       │ SQLite (better-    │
                                                       │ sqlite3)           │
                                                       └────────────────────┘
```

### 4.1 Components
| Component | Responsibility |
|---|---|
| `FlowEngine` | Loads and validates a flow, owns the advance loop, resolves edges, dispatches tools. |
| `Session` | Plain serialisable object: `callId`, `currentNodeId`, `transcript`, `variables`, timestamps. Kept behind a `SessionStore` interface (in-memory for Phase 1). |
| `ModelRouter` | Maps a node's `model` field to a provider client. Handles provider-specific request options. |
| Tool registry | Maps tool names to a Zod-validated input schema and an async handler. |
| `db/` | SQLite connection, migrations, seed script, repository functions. |
| Adapters | Convert a channel event into `engine.start()` or `engine.handleUser()`, and the `TurnResult` back into channel output. |

### 4.2 Agent framework (Claude SDK)
- Package: **`@anthropic-ai/sdk`** (TypeScript). The Messages API with tool use is the agent loop. The SDK's tool runner can drive the business-tool rounds inside a node.
- **Decision to confirm (see §14):** the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) packages Claude Code (filesystem/bash tools, subprocess harness). It is a poor fit for a low-latency, per-turn voice loop. The engine therefore keeps the agent loop behind an `AgentRuntime` interface so the Agent SDK could be swapped in for a specific node later without touching flow data.
- Edge transitions are exposed to the model as tools named `transition__<edge_id>`. The edge's `condition.prompt` is the tool description.
- Because forced `tool_choice` (`any`/`tool`) returns a 400 on Sonnet 5.5, the engine uses `tool_choice: auto`, `strict: true` tool schemas, and prompt-level steering.

### 4.3 Models
| Item | Decision |
|---|---|
| Default model | `claude-sonnet-5-5` (Sonnet 5.5), set once in `default_model` |
| Per-node override | Node field `model`. Format `anthropic/<id>` (default provider) or `openrouter/<vendor>/<model>`. |
| Thinking | Default: `thinking: { type: "adaptive" }` at `effort: "low"` (the migration guide's first recommendation). `{type:"disabled"}` is a 400 on Sonnet 5.5. Option to benchmark at M3 for lower latency: per-node `thinking: "between_tools"` (no extended thinking, effort `high` or below). |
| Effort | Set per node via the static, top-level `output_config.effort` (default `low`). **Never change effort mid-conversation with per-message effort**: it is a 400 under `between_tools`, and changing top-level effort invalidates the prompt cache. Node-level effort is fine because each node has its own system prompt anyway. |
| Thinking blocks | Pass `thinking` blocks back unchanged inside a single turn's tool loop. They are bound to the model and conversation (history-editing check), so the engine does not replay them across turns. `session.transcript` stays plain text, and nodes with different system prompts never share thinking blocks. |
| Sampling params | Do not send `temperature`, `top_p` or `top_k`. Non-default values are rejected on Sonnet 5.5. |
| Prefill | Not supported. Steer through the system prompt. |
| Output length | `max_tokens` is small by default (300). Replies are spoken aloud, so 1–3 short sentences with no markdown. |
| Refusals | Always check `stop_reason` before reading `content`. Enable server-side fallback (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`) on Anthropic-provider calls. It only retries `cyber` and `frontier_llm` declines. `bio`, `reasoning_extraction` and `general_harms` refusals are not retried, so the engine must handle any `stop_reason: "refusal"` by speaking a safe line and staying on the current node. With `between_tools`, a fallback to Sonnet 5 runs with thinking disabled. |
| Model-specific flags | Thinking, effort and fallback options are Anthropic-only. The router strips them for OpenRouter models. |

### 4.4 OpenRouter (optional provider)
- Enabled only if `OPENROUTER_API_KEY` is set. Phase 1 works with just `ANTHROPIC_API_KEY`.
- Integration: OpenRouter exposes an Anthropic-compatible endpoint, so the same SDK client can be constructed with `baseURL: "https://openrouter.ai/api"` and the OpenRouter key. **Verify against current OpenRouter docs before building**, including tool-use and streaming parity for non-Claude models. If parity is poor, fall back to OpenRouter's OpenAI-compatible endpoint behind the same `ModelClient` interface.
- Nodes that name an `openrouter/...` model fail at flow-load time if the key is missing. This is a clear error, not a runtime surprise.
- Known limits: no Anthropic server-side refusal fallback, no `between_tools` thinking and no effort control on non-Claude models. The router logs which options it dropped.

## 5. Flow definition

A flow is one JSON file validated with Zod at load time. Top-level fields: `base_instructions`, `default_model`, `variables`, `start_node`, `nodes`, `edges`, `end_states` (a map of name to `{ message }`).

### 5.1 Node (Phase 1: only type `prompt`)
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
| `id`, `from`, `to` | `to` is a node id or an `end_states` key. Entering an end state speaks its `message` and ends the session. |
| `condition.type` | `"llm"` in Phase 1 (becomes a `transition__<id>` tool). `"expression"` is reserved, so deterministic transitions can later skip the model call. |
| `condition.prompt` | Tells the model when to take the edge. |

### 5.3 Engine semantics (carried over from the existing design notes)
- A transition tool call re-runs the **target node on the same utterance**. Text already spoken this turn is injected into the next node's system prompt so it does not repeat the greeting.
- Transition wins over business tool calls made in the same response.
- `max_hops` per caller utterance (default 4) guards against routing loops.
- `Session.transcript` stores plain-text turns only. Facts that must persist across turns go into `session.variables`.
- Every handled utterance must be idempotent on a `turnId`, so a webhook retry never re-runs tools or duplicates the transcript.

### 5.4 Phase 1 flow

```jsonc
{
  "default_model": "anthropic/claude-sonnet-5-5",
  "start_node": "start",
  "end_states": {
    "verified": { "message": "Thanks {{customer_first_name}}, you're verified. One moment while I get you to the right place." },
    "failed":   { "message": "I'm sorry, I wasn't able to verify your identity, so I can't continue with this request. Please try again later or contact us directly. Goodbye." }
  },
  "nodes": [
    {
      "id": "start", "type": "prompt", "model": "anthropic/claude-sonnet-5-5", "effort": "low", "tools": [],
      "instructions": "Greet the caller warmly, say you are the virtual receptionist, and ask how you can help. Do not ask for personal details yet."
    },
    {
      "id": "verify", "type": "prompt", "model": "anthropic/claude-sonnet-5-5", "effort": "low", "tools": ["verify_identity"],
      "instructions": "The caller must be verified before anything else. Ask for their customer ID and date of birth, one at a time if needed. Call verify_identity once you have both. Never state which detail was wrong. Never read back stored data."
    }
  ],
  "edges": [
    { "id": "e_start_verify", "from": "start", "to": "verify",
      "condition": { "type": "llm", "prompt": "The caller has said why they are calling or what they need." } },
    { "id": "e_verify_ok", "from": "verify", "to": "verified",
      "condition": { "type": "llm", "prompt": "verify_identity returned verified=true." } },
    { "id": "e_verify_fail", "from": "verify", "to": "failed",
      "condition": { "type": "llm", "prompt": "verify_identity returned locked=true, or the caller refuses to verify." } }
  ]
}
```

> **Guardrails (engine-enforced, both directions):**
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

### 6.2 SQLite schema (Phase 1)

```sql
CREATE TABLE customers (
  id            INTEGER PRIMARY KEY,
  customer_id   TEXT NOT NULL UNIQUE,      -- e.g. 'C1001'
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
  reply: string;                  // text to speak or display (includes the end-state message when ended)
  nodeId: string;                 // node (or end state) after this turn
  ended: boolean;                 // true when an end state is reached
  endState?: "verified" | "failed";
  actions: Action[];              // reserved: transfer, hangup (later)
}

interface FlowEngine {
  start(callId: string, ctx: { callerNumber?: string }): Promise<TurnResult>;
  handleUser(callId: string, utterance: string, turnId: string): Promise<TurnResult>;
}

interface ModelClient {           // implemented by Anthropic + OpenRouter clients, and FakeClaude in tests
  createMessage(req: ModelRequest): Promise<ModelResponse>;
}

interface SessionStore {          // Phase 1: in-memory Map
  get(callId: string): Promise<Session | undefined>;
  put(session: Session): Promise<void>;
  delete(callId: string): Promise<void>;
}
```

- A call opens with `start()`, which runs the `start` node with no caller utterance and returns the greeting.
- Empty replies are never returned. If the model returns only tool calls with no text after `max_tool_rounds` or `max_hops`, the engine substitutes a safe fallback line ("Sorry, could you say that again?"). **This does not apply when the turn reached an end state**, because the end state's `message` is the reply. A refusal (`stop_reason: "refusal"`) also gets a safe spoken line and leaves the session on the current node.
- Sessions end when an end state is reached or a TTL (default 30 min) expires. The store sweeps expired sessions.
- Errors from a model provider return a spoken apology and keep the session on the current node. Retry (SDK default) covers transient 429/5xx.

## 8. Project layout

```
receptionist/
├── PRD.md
├── package.json            # type: module; scripts: dev, cli, test, db:seed, typecheck
├── tsconfig.json           # strict: true
├── .env.example            # ANTHROPIC_API_KEY, OPENROUTER_API_KEY (optional), DB_PATH
├── flows/
│   └── receptionist.json
├── src/
│   ├── engine/             # flow-engine.ts, session.ts, edges.ts, templating.ts
│   ├── flow/               # schema.ts (Zod), load.ts
│   ├── models/             # router.ts, anthropic.ts, openrouter.ts, types.ts
│   ├── tools/              # registry.ts, verify-identity.ts, normalise.ts
│   ├── db/                 # connection.ts, schema.sql, seed.ts, repo.ts
│   ├── adapters/           # cli.ts, http.ts (Fastify or Hono)
│   └── index.ts
└── test/                   # vitest; fake-claude.ts, routing.test.ts, verify.test.ts
```

Stack: Node 22+, TypeScript (strict), `@anthropic-ai/sdk`, `zod`, `better-sqlite3`, `vitest`, `tsx`. HTTP adapter: Hono or Fastify (decide at M3).

## 9. Configuration

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic provider (Sonnet 5.5). |
| `OPENROUTER_API_KEY` | No | Enables `openrouter/...` models. |
| `DB_PATH` | No | Defaults to `./data/receptionist.db`. |
| `FLOW_PATH` | No | Defaults to `./flows/receptionist.json`. |
| `MAX_HOPS`, `SESSION_TTL_SECS` | No | Engine guards. |

Never commit keys. The flow file never contains secrets.

## 10. Requirements

### Functional
- FR1. Load and validate a flow file. Reject unknown node/edge references, unreachable nodes, missing models and unknown tools at startup.
- FR2. `start()` returns a greeting from the start node.
- FR3. The start node moves to verify on the caller's first stated need, in the same turn, without re-greeting.
- FR4. `verify_identity` returns pass/fail per §6.1, with the attempt limit enforced in code.
- FR5. Entering the `verified` end state requires `session.variables.verified === true` (engine-enforced).
- FR6. Per-node `model` override works for both `anthropic/` and `openrouter/` models.
- FR7. A CLI to converse with the flow, and an HTTP endpoint `POST /calls/:id/turn`.
- FR8. Every turn is idempotent on `turnId`.

### Non-functional
- NFR1. Latency: a single-node turn with no tool call should reach first reply token in under ~1.5 s p50 (streaming). A transition turn (two model calls) is tracked as a metric, since it is the main source of dead air.
- NFR2. All behaviour is testable offline with a fake `ModelClient`. No network in unit tests.
- NFR3. Structured JSON logs per turn: `callId`, node, hops, tool names, model, token usage, latency. PII redacted.
- NFR4. TypeScript strict mode, no `any` in `src/engine`.

## 11. Testing strategy

- **`FakeClaude`** returns scripted content blocks per request and records request args (model, tools, system prompt). Copy `messages` when snapshotting, since the engine mutates the array.
- **Routing tests:** greeting stays on start; stated need transitions in the same turn; no double greeting; `max_hops` cap; transition beats business tool call.
- **Verify tests:** success, wrong DOB, unknown ID (identical response), 3-strike lockout, spoken-digit normalisation, suspended account, model forging `e_verify_ok` without a verified flag is rejected, tool output never contains customer data.
- **Idempotency test:** replaying the same `turnId` returns the stored result and does not call tools or the model again.
- **DB tests:** in-memory SQLite (`:memory:`) per test, seeded fixtures.
- **Live smoke test (manual, opt-in):** real Sonnet 5.5 call through the CLI with a scripted caller, gated behind `RUN_LIVE=1`.

## 12. Milestones

| M | Deliverable | Done when |
|---|---|---|
| M0 | Scaffold: TS project, Zod flow schema, loader, `.env.example` | Typecheck passes and the sample flow validates. |
| M1 | Engine + `FakeClaude` + start node | S1 and S2 pass offline. |
| M2 | SQLite schema, seed, repo, `verify_identity`, verify node | S3–S7 pass offline. |
| M3 | Real Anthropic client (Sonnet 5.5), CLI, HTTP adapter | A full live conversation works in the CLI. |
| M4 | OpenRouter provider + per-node override | One node runs an OpenRouter model, with the key missing producing a load-time error. |
| M5 | Logging/metrics, TTL sweeper, docs | NFR1–NFR3 met. |

## 13. Risks

| Risk | Mitigation |
|---|---|
| LLM claims verification without a tool pass | Engine-enforced `verified` guard (§5.4); tool is the only writer of the flag. |
| Identity data leaked to the caller or logs | Minimal tool output, redacted logs, no stored-data readback. |
| Weak verification factors (ID + DOB are guessable or known to others) | Attempt limits, per-ID rate limit, ANI signal. Add a PIN or OTP factor before exposing sensitive data (Phase 2). |
| Speech-to-text mangles IDs and dates | Normalisation layer, a confirm-back step for the ID, then a DOB re-ask. |
| 2+ sequential model calls per transition cause dead air | Measure; later add `expression` edges and stream the first node's text while the next node runs. |
| OpenRouter parity with Anthropic tool use for non-Claude models | Verify before M4. Keep a `ModelClient` abstraction and an OpenAI-compatible fallback. |
| Sonnet 5.5 API specifics change (thinking, effort, tool_choice) | Isolate provider request-building in `models/anthropic.ts`. Pin the SDK version. |
| In-memory sessions lost on restart / break with multiple workers | Acceptable for Phase 1. `SessionStore` interface is the seam for Redis or DynamoDB. |

## 14. Open questions

1. **Agent framework:** Is "Claude SDK" meant as `@anthropic-ai/sdk` (assumed here) or the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)? The assumption fits a per-turn voice loop better. The Agent SDK is possible per node behind `AgentRuntime`.
2. **Verification factors:** Are customer ID + DOB acceptable, or should the first release use name + DOB, phone number lookup, or a PIN?
3. **Failure handling:** After lockout, should `failed` hang up, transfer to a human, or hand off to a "callback" node (a future node)?
4. **Channel first:** CLI plus HTTP only for Phase 1, or should the Telnyx TeXML adapter be pulled forward?
5. **HTTP framework:** Hono or Fastify?
6. **Caller identity by ANI:** should a matching caller number ever lower the bar (for example skip the ID question), or stay signal-only?
7. **Existing `CLAUDE.md`:** it describes a Python implementation (`engine.py`, `flow.json`) that is not in this directory. Should it be rewritten for the TypeScript project once M0 lands?

## 15. Phase 2 preview (out of scope now)

`speak` and `tool` node types, `expression` edges, post-verification business nodes (account lookup, transfer), the Telnyx TeXML voice adapter with a status callback for session cleanup, external session store, webhook signature verification, and AWS deployment.
