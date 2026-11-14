# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project goal

A Telnyx-style AI voice receptionist: a conversation-flow engine on the Claude Messages API (`anthropic` SDK), reached over the phone via Telnyx TeXML webhooks. The stated direction is to run this on AWS. Nothing AWS-specific exists yet. Sessions are in-memory and the "back-office" data is fake (see Production gaps).

## Commands

Flat Python layout, no build step, no linter, no git repo. Run everything from the repo root, because `flow.json` is opened by relative path.

```bash
pip install -r requirements.txt
cp .env.example .env                  # ANTHROPIC_API_KEY, PUBLIC_BASE_URL, VOICE_LANGUAGE
python test_routing.py                # routing tests, scripted fake client, no API key needed
python cli.py                         # chat with the flow in the terminal (needs a real API key)
uvicorn server:app --port 8000        # phone entrypoint; expose via ngrok and set PUBLIC_BASE_URL
```

- Point the Telnyx TeXML application's Voice URL (POST) at `/texml/inbound`.
- `server.py` reads `os.environ["PUBLIC_BASE_URL"]` at import time, so it won't start without it.
- `test_routing.py` is a plain script. It calls `asyncio.run(main())` at module level and is not pytest-style. To run one test, edit `main()`, or import the module's functions in a REPL.

## Architecture

The flow is data and the engine interprets it. Telnyx's agent-flow concepts map onto Claude like this:

- **`flow.json`** defines the whole call: `base_instructions`, `variables`, `default_model`, `nodes`, `edges`. Nodes can set `model` to override the default per node. Changing call behaviour usually means editing this file, not Python.
- **`engine.py`** (`FlowEngine`) interprets the flow. `_advance` is the core loop. It runs up to `max_hops` node hops per caller utterance, which guards against routing loops.
- **`tools.py`** is the tool registry (`TOOLS`). One registry serves two roles: business tools that Claude calls from prompt nodes, and call-control tools (`transfer_call`, `hang_up`) that tool nodes run directly. A tool returns `ToolResult(data, status, actions)`. `data` is shown to Claude, and `actions` go to the voice layer.
- **`server.py`** is a FastAPI TeXML adapter. `inbound`, `gather` and `no-input` each convert one webhook into an `engine.start` or `engine.handle_user` call. `to_texml` turns the `TurnResult` into `<Say>`/`<Gather>`, `<Dial>` or `<Hangup/>`.
- **`cli.py`** drives the same engine from stdin, so you can iterate on flows without a phone line.

### Node types and edge semantics (`engine.py`)

- `speak`: renders `message` with no model call, then follows its single `default` edge.
- `tool`: runs a tool with no model call, optionally saying `message` first. Its `arguments` are templated, and unspecified tool params are filled from session variables by name. With no outgoing edge it is terminal and the session ends.
- `prompt`: one Claude call plus up to `max_tool_rounds` of business-tool rounds.
- **Edge precedence on a prompt node:**
  1. `expression` edges are checked first, before any model call. `e_rec_timeout` uses this to transfer to the operator after 300s, without calling Claude.
  2. `llm` edges become Claude tools named `transition__<edge_id>`, with the edge's `condition.prompt` as the tool description. If Claude calls one, the engine moves to the target node and re-runs that node on the **same utterance**. Text spoken earlier in the turn is injected into the next node's system prompt so it doesn't re-greet.
  3. `default` edges are only valid on `speak`/`tool` nodes. `_validate` asserts this at construction.
- A transition tool call wins over business tool calls made in the same response. The business calls are dropped.
- `{{var}}` templating applies to messages, instructions and tool arguments. System variables `conversation_duration_secs` and `last_tool_status_code` are maintained by the engine.
- `Session.transcript` stores plain-text turns only. Tool calls and results are not replayed on later turns. They live only within the current turn's tool loop, so facts that must persist go into `session.variables`. `check_leave_balance` does this with `employee_id`. `_system_prompt` surfaces only `caller_number` and `employee_id` to Claude.
- Replies are capped at `max_tokens=300`, and every reply is read aloud. `base_instructions` enforces 1–3 short sentences with no markdown.

### Testing pattern

`test_routing.py` injects a `FakeClaude` through `FlowEngine(flow, client=...)`. Each test supplies the ordered list of content blocks Claude would return, and asserts on `node_id`, `actions`, session variables and recorded request kwargs (for example, the per-node `model`). Any new flow behaviour should be testable this way without network access. Caveat: `calls[i]["messages"]` is the same list object the engine keeps appending to, so asserting on request messages will see later rounds mixed in. Copy it if you need a snapshot.

## Production gaps

- `server.SESSIONS` is an in-process dict keyed by `CallSid`, so it breaks under multiple workers or instances and loses state on restart. The code comments say to use Redis. Moving to AWS would mean an external session store, since `Session` is a plain dataclass.
- `tools.py` back-office data (`LEAVE`, `INVOICES`) is hardcoded fake data, and `apply_leave` always returns the same request ID.
- Sessions are never cleaned up when a caller hangs up mid-call (no status callback or TTL), and `inbound` doesn't pop a session that ends during `start`.
- One utterance can cost 3+ sequential Claude calls (transition, then target node, then tool round), with dead air for the caller. `handle_user` isn't idempotent, so a webhook retry duplicates the transcript turn and could call `apply_leave` twice.
- If every tool round ends in a tool call with no text, or `max_hops` runs out, the reply is empty and `listen("")` plays silence.
- `e_rec_timeout` tests total call time, not idle time, and runs on every arrival at `n_reception`, including returns from HR/Finance. A caller who has been in HR for 5+ minutes and then asks a non-HR question is sent to the operator and the question is dropped. It also only fires when the caller speaks. Confirm this is intended.
- No Telnyx webhook signature verification, and no caller verification for HR data (any valid employee ID works).
- Unverified against Telnyx docs: bare-number `<Dial>`, `speechTimeout` units, and whether Telnyx accepts language/voice attributes on `<Say>` (the code emits none, so `VOICE_LANGUAGE` only affects recognition).
- Tool ID lookups don't normalise speech-to-text output (e.g. "E 1001").
- The voice loop is TeXML `<Gather input="speech">`, one turn per HTTP round trip, with no streaming audio.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `bitlabsdevteam/AI_receptionist_claude_sdk`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
