# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

An AI voice receptionist, built as a **harness** around Claude: a conversation-flow engine on the Anthropic Messages API (`@anthropic-ai/sdk`), in TypeScript on Node 24. A Flow, defined as data, says how a Call can unfold. The engine runs one Node at a time, answers each Caller Turn as the Receptionist, and follows an Edge or ends the Call in an End state. The governing rule is **the model proposes, code decides**: Claude writes the words and suggests Edges, and code owns every fact that matters (see Harness invariants below). The target channel is voice over Telnyx, which is not built. Today a Call runs only in the terminal, typed (`npm run chat`) or spoken (`npm run talk`, with ElevenLabs as the Voice), and the Flow is a single `start` Node with a `goodbye` End state. The spec is `PRD.md` (read section 8 for the harness), `TDD.md` is the technical design for the phone voice agent (it is git-ignored, so a worktree or a fresh clone has no copy), and the vocabulary is `GLOSSARY.md` (Call, Flow, Node, Edge, End state, Turn, Voice, Receptionist, Caller, Harness, Guard, Trace, Scenario, Simulated Caller). Use those terms in code, comments and docs. `Session` is only the code-level name for a Call's state.

## Commands

Run from the repo root. Flow paths and `.env` are resolved relative to the working directory (the CLI's default Flow path is the exception: it is relative to the project).

```bash
npm ci                                # install, versions are pinned
npm run typecheck                     # tsc --noEmit, strict
npm test                              # vitest run, offline, no API key
npm run chat                          # a typed Call in the terminal (needs ANTHROPIC_API_KEY)
npm run talk                          # a spoken Call in the terminal (also needs ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, macOS, ffmpeg)
npm run test:live                     # opt-in checks against the real APIs (RUN_LIVE=1), spends money
cp .env.example .env                  # then set the keys (.env is git-ignored, never commit a key)
```

- `npm run chat` reads `ANTHROPIC_API_KEY` from the environment or `.env`. With no key (or the `sk-ant-...` placeholder) it prints a `ANTHROPIC_API_KEY is not set` message and exits 1. `FLOW_PATH` overrides the Flow file (default `flows/receptionist.json`) for `chat` and `talk` alike.
- `npm run talk` also needs `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`. It prints one `... is not set` line for every variable that is missing and exits 1 before anything is sent. `ELEVENLABS_MODEL_ID`, `ELEVENLABS_STT_MODEL_ID` and `ELEVENLABS_BASE_URL` are optional, and `.env.example` gives their defaults.
- To run one test file: `npx vitest run test/turn.test.ts`.
- `npm test` skips `test/live.test.ts` and `test/live-voice.test.ts`. `npm run test:live` runs both, and each fails with its own missing-key message when its key is not set.

## Architecture

The Flow is data and the engine interprets it. Changing how a Call behaves usually means editing `flows/receptionist.json`, not TypeScript.

- **`flows/receptionist.json`** is the Flow: `base_instructions`, `variables`, `default_model`, `start_node`, `nodes`, `edges`, `end_states`. Nodes may override `model` and `effort`. Model references look like `anthropic/<id>` or `openrouter/<vendor>/<model>`.
- **`src/flow/`**: `schema.ts` is the Zod schema plus cross-reference checks (unknown Edge targets, duplicate ids, unreachable Nodes, unknown tools). `load.ts` reads and validates a Flow file. A bad Flow throws `FlowValidationError` listing every problem.
- **`src/engine/engine.ts`**: `FlowEngine` has `start(callId, ctx, stream?)` and `handleUser(callId, utterance, turnId, stream?)`. A Turn runs up to `maxHops` Nodes (default 4) on the same utterance, which guards against routing loops. State lives in a `Session` held by a `SessionStore` (only `InMemorySessionStore` exists; it stores clones, so it behaves like an external store).
- **`src/engine/run-node.ts`**: `runNode` makes one model call with the Node's rendered instructions as the system prompt (`base_instructions` first). `MAX_TOKENS` is 1024.
- **`src/adapters/`**: `chat.ts` is the typed Call loop (`runChat`) and `cli.ts` wires it to readline. `program.ts` is what the two programs share: the Flow from `FLOW_PATH`, the engine on the real client, and the exit code (a thrown error's message goes to stderr and the program exits 1). `talk.ts` is the spoken Call loop (`runTalk`). `talk-terminal.ts` (`openTalkTerminal`) is the Caller's side of it on readline: typed lines, the Enter that stops a recording, and Ctrl-C. `talk-cli.ts` wires both to `ElevenLabsVoice` and the `ffmpeg` recorder (see Voice below). `line-queue.ts` holds the Caller's typed lines for `talk-terminal.ts`, so that a wait for Enter can be called off without swallowing the next line. `terminal-reply.ts` renders streamed replies and erases withdrawn ones. Adapters are thin and the engine knows nothing about terminals or speech.
- **`src/voice/`**: `voice.ts` is the `Voice` interface (`speak(text)` and `listen(onRecorded?)`) with `VoiceError` and `VoiceInterrupted`. `elevenlabs.ts` is `ElevenLabsVoice`, the only real one, and `elevenlabs-env.ts` reads its variables from the environment and words the `... is not set` lines for the missing ones (`src/config.ts` reuses them at startup). `player.ts` plays the audio with `afplay`, `recorder.ts` records the microphone with `ffmpeg`, and `wav.ts` measures the recorded clip. Nothing in `src/voice/` imports from `src/engine/`.

### Model client

`ModelClient` (`src/engine/model.ts`) is the only seam to a model: `createMessage(req, onTextDelta?)` returns content blocks and a `stopReason`. `AnthropicModelClient` (`src/engine/anthropic-client.ts`) is the real one and `FakeClaude` (tests) is the scripted one. `ModelRequest` deliberately has no `temperature`, `top_p` or `top_k`, which Sonnet 5.5 rejects. The Anthropic client always sets adaptive thinking, `output_config.effort` from the Node (default `low`, since the API default is too slow for voice), and the server-side fallback beta.

### Edges, transition tools and End states

- Each Edge from the current Node is offered to the model as a strict tool named `transition__<edge_id>`, described by the Edge's `condition.prompt`. Strict tools, not forced `tool_choice`, are how the engine steers the model, because forced `tool_choice` is a 400 on Sonnet 5.5.
- If the model calls one, the engine moves to the target and re-runs it on the same utterance. Text already said this Turn is injected into the next Node's system prompt so it does not greet again, and the reply is the pieces joined with a single space. If several Edges are called, the first wins.
- An Edge whose `to` is an End state finishes the Call: the End state's templated `message` is spoken after anything already said (even nothing), `Session.endState` is set and the result has `ended: true`. The Node's instructions must tell the model not to say a farewell of its own. An ended Call rejects further Turns, though a replay of the ending Turn still returns its stored result.
- A refusal (`stopReason: "refusal"`, which is a normal HTTP 200) discards the whole Turn: the Call stays on its Node and `REFUSAL_LINE` is spoken. An empty reply becomes `EMPTY_REPLY_LINE`. A refused response never takes an Edge. `start()` handles a refused or empty greeting too, with a safe greeting built from the Flow's `receptionist_name` and `company_name` variables, and never stores the refused text. A refused Turn stays in the transcript (marked `refused`; a repeated turn id replays its stored result from `Session.turns`) but is left out of the history sent to the model, and the history never contains an empty message.
- `{{var}}` templating (`templating.ts`) applies to instructions and End state messages. An unknown variable throws `UnknownVariableError`.

### Turns, transcript and idempotency

`handleUser` is idempotent on `turnId`: a repeat returns the stored `TurnResult` without calling the model or touching the transcript. Turns on one Call run one at a time (a per-Call queue). A Turn that throws is not recorded, so the Caller can retry. `Session.transcript` holds plain text only. Tool calls and thinking are never replayed across Turns, so anything that must persist goes in `Session.variables`.

### Streaming rule

`ReplyStream` (`src/engine/reply-stream.ts`) has `text(delta)` and `discard()`. The rule every stream can rely on: when a Turn finishes, what the stream was shown is exactly the Turn's reply, End state message and safe lines included. If the reply changed after text was shown (a refusal, or a failed request), `discard()` is called first, everything shown is void, and the true reply follows from nothing. `ReplyWriter` enforces this, so engine code never writes to a stream directly. Keep it intact when changing the engine or adding an adapter.

### Voice

The Voice is speech out and speech in on a spoken Call. It lives in the adapter, around `start()` and `handleUser()`, and the engine is unchanged by it. `ElevenLabsVoice` calls ElevenLabs' text-to-speech and speech-to-text endpoints with plain `fetch`, so there is no ElevenLabs dependency. It is not a tool the model can call and not the ElevenLabs Agents platform. `FakeVoice` (tests) is the scripted one.

`runTalk` holds the rules below, each covered by a test in `test/talk.test.ts` (and in `test/talk-cli.test.ts` for the program as a whole). They are adapter rules, not numbered Harness invariants.

- **Speaking.** The Voice speaks the Turn's final `reply` (the greeting, a safe line and an End state's message included), once, after the Turn has finished and its text is printed. Speech waits for the finished Turn because I6 allows `discard()` while text streams, and speech cannot be unspoken.
- **Listening** is push-to-talk. Enter on an empty line starts a recording and the next Enter stops it, then the clip is transcribed and shown as `You: ...`. A typed line is sent as it is, with no listening.
- **Empty or failed transcript.** `runTalk` answers it itself (`I didn't catch that. Please try again.` or a `(Could not hear you: ...)` line) and asks again. Only non-empty text reaches `handleUser()`, and no turn id is spent.
- **Speech failure.** The text is always printed. A `speak()` that throws costs one `(Could not speak: ...)` line and the Call carries on. It never changes the `TurnResult`, never ends the Call and is never fed to the model.
- **Interrupt.** Ctrl-C or a closed input during a recording raises `VoiceInterrupted` (in `talk-terminal.ts`, tested in `test/talk-terminal.test.ts`), which stops the recorder and ends the Call with exit code 0. `recordClip` kills an `ffmpeg` that has not exited 10 s after being asked to stop, so the Call cannot hang on it.
- **Timing line.** With a `TalkOptions.clock` (`talk-cli.ts` passes one), each Turn is followed by `(Timing: record N ms, transcribe N ms, model N ms, speak N ms)`. A typed Turn has only `model` and `speak`, and the greeting, an empty transcript, a failed listen and a failed Turn have no line. It is plain terminal output, not a Trace. `model` is the whole Turn in the engine, every hop included. `record` includes `ffmpeg` starting and stopping, and `speak` includes playing the whole reply, so the line does not show how long the Caller waited to hear the reply begin.

`ElevenLabsVoice` never reads the body of a failed response, and no error message or `cause` it raises contains the API key.

## Harness invariants

These hold today and are each covered by a test (I7 is asserted for sampling parameters, thinking, tool choice and effort; nothing yet asserts the absence of prefill). Preserve them when you change the engine, the model client or an adapter. They are numbered as in `PRD.md` section 8.1.

- **I2** An Edge is applied by the engine, never by the model, and never from a refused response.
- **I3** An empty reply is never spoken. It becomes a safe line (an End state's message counts as the reply).
- **I4** Refused text is never stored as the Receptionist's words, and a refused Turn is never replayed to the model. The history sent to the model never contains an empty message.
- **I5** A Turn is idempotent on `turnId`, and Turns on one Call run one at a time.
- **I6** What a stream was shown equals the Turn's final reply, or `discard()` is called first (see Streaming rule).
- **I7** Requests never carry `temperature`, `top_p` or `top_k`, never disable thinking, never use prefill or forced `tool_choice`, and always set effort.

When you add behaviour, put the rule in code and add a test that fails if the model tries to break it. Do not rely on the prompt alone. The rest of the planned harness (I1, I8, I9 identity and tool Guards, I10 PII redaction in Traces) is in the PRD and is not built: do not describe it as existing.

## Testing

Tests are vitest files in `test/` and run offline. `test/fake-claude.ts` is a scripted `ModelClient`: build it with the ordered responses the model would give (`say("...")`, `reply([...blocks], stopReason)`, `failAfter(text, error)`, plus the shared `transition(edgeId, text?)`, `goodbye(text?)`, `flowWithBilling(flow)`, `GREETING` and `GOODBYE_MESSAGE`; build tool names with `transitionToolName`), inject it with `new FlowEngine(flow, { client })`, then assert on `TurnResult`, the session in the store, streamed text and the recorded `requests` (system prompt, tools, `model`, `effort`, `maxTokens`). Requests are cloned when recorded, so later mutation by the engine does not leak into them. It streams word by word like the real client. `test/sse.ts` builds canned HTTP streams, so `anthropic-client.test.ts` exercises the real SDK with no network. Any new Flow behaviour should be testable this way.

A spoken Call is tested the same way. `test/fake-voice.ts` is a scripted `Voice`: `new FakeVoice(heard, speakFailures)` gives the scripted transcripts or errors from `listen()` in order, records what was handed to `speak()` in `spoken`, and calls `onPhase` so a fake clock can advance. Pass it to `runTalk(engine, voice, io, { clock })` with a `FakeClaude` engine. `ElevenLabsVoice` takes an injected `fetch`, `player` and `recorder`, so `elevenlabs.test.ts` answers with canned HTTP responses, plays nothing and opens no microphone. `test/fake-ffmpeg.ts` is the stand-in `Spawner` for `recordClip`, and `test/wav.ts` builds WAV clips. `talk-cli.test.ts` runs the real program in a child process against one local HTTP server that stands in for Anthropic and ElevenLabs (`ANTHROPIC_BASE_URL`, `ELEVENLABS_BASE_URL`), with a `PATH` holding only stand-ins for `afplay` and `ffmpeg`. It proves the wiring and nothing about the live services. `talk-terminal.test.ts` drives `openTalkTerminal` through in-memory streams marked as a terminal, which is how Ctrl-C is tested with no terminal and no child process.

`test/live.test.ts` is the opt-in check against the real model. It asserts facts that hold on every run (name, no markdown, closing message appears once, stream equals reply), not exact wording. `test/live-voice.test.ts` is the opt-in check of `ElevenLabsVoice` against the real endpoints: it speaks one sentence to a player that keeps the mp3 instead of playing it, then transcribes that mp3, so nothing is played and the microphone is never opened. `test/live-gate.test.ts` proves offline that `npm test` skips the live Voice check and that `npm run test:live` with empty keys stops on the missing-key message.

## Gotchas

- Node 24 is required (`engines`), and `process.loadEnvFile` is used for `.env`.
- Dependencies are pinned to exact versions, including `@anthropic-ai/sdk`. The SDK is called through `client.beta.messages.stream`, because `betas` and `fallbacks` do not exist on the plain Messages API.
- Never send `temperature`, `top_p` or `top_k`. Never disable thinking (`{type:"disabled"}` is a 400 on Sonnet 5.5) and never use prefill. Always set effort explicitly.
- Adaptive thinking counts toward `max_tokens` even though it is not returned, which is why the cap is 1024 and not the 300 an earlier draft planned. Replies stay short because the Flow's instructions say 1 to 3 sentences with no markdown, since every reply is read aloud.
- The client keeps every tool call that arrived with complete JSON input, whatever the stop reason (so a truncated reply still takes a `transition__` Edge), and drops one cut off mid-input. It checks the raw stream JSON for this, because the SDK silently turns a cut-off input into `{}` or a half-filled object. The engine still never takes an Edge from a refusal.
- vitest has no config and uses its default include globs. Run from the main checkout, it also picks up copies of the tests inside `.claude/worktrees/*`, so run it from inside the checkout or worktree you are working in. Most tests also read `flows/`, `src/` and `.env.example` relative to the current directory, so they fail under `vitest --root` from elsewhere.
- `.env.example` lists `OPENROUTER_API_KEY` and `DB_PATH` (marked "not used yet" there), but nothing reads them.
- `npm run talk` is macOS only: replies are played with `afplay`, and the microphone is recorded with `ffmpeg` through avfoundation (`brew install ffmpeg`). Neither is checked at startup. A missing `ffmpeg` shows at the first recording as a `(Could not hear you: ...)` line that says what to install, and typed lines still work. A reply that cannot be played costs a `(Could not speak: ...)` line.
- The `(Recording. Press Enter to stop.)` prompt appears when `ffmpeg` is started, not when the microphone is open, and nothing knows that moment. Words said straight away may be missed.

## Not built yet

The roadmap and milestones are in `PRD.md` section 13. The harness layers below do not exist yet (Voice exists for the terminal only), so do not write code or docs as if they did:

- **Traces** (PRD 8.4): nothing logs today, and `ModelResponse` carries no token usage or timings. The timing line of `npm run talk` is terminal output, not a Trace.
- **Guards as named, Flow-referenced rules** (PRD 8.3): only the built-in Edge and reply rules in "Harness invariants" exist. There are no identity, tool or data Guards.
- **Evaluation harness** (PRD 8.5): only tier 1 (offline scripted tests with `FakeClaude`) exists. There are no Scenarios, Simulated Caller, judge, Trace replay or regression gate.
- **Prompt caching** (PRD 8.2): no `cache_control` is sent.
- **Voice** (PRD 8.6): built for Option C only, a spoken Call in the terminal (see Voice above). There is no Telnyx adapter and no HTTP server, and the first phone adapter is an open question in the PRD (section 15, Q4). There is no barge-in (the Caller cannot interrupt a reply that is being spoken), no silence detection (Enter starts and stops a recording), no real-time audio streaming and no speaking while text streams. Playback and recording work on macOS only.

Also from the PRD (later): `speak` and `tool` Node types, `expression` Edges, post-verification business Nodes (account lookup, transfer), webhook signature verification, an external session store, AWS deployment. Also not built, though the PRD plans them next: the `verify` Node and SQLite, a tool registry and business tools (a Node's `tools` list must be empty today, and `runNode` ignores business tool calls), the HTTP adapter, the `max_tool_rounds` Node setting (the schema accepts it, but nothing reads it until business tools exist), the `Action` type in `turn.ts` (reserved for transfer and hang-up, and `TurnResult.actions` is always empty), an OpenRouter client (the schema accepts `openrouter/...` models but `AnthropicModelClient` throws on them), and `MAX_HOPS` / `SESSION_TTL_SECS` configuration.

Known gaps:

- `start()` offers no transition tools while greeting, so the Call cannot end on its first reply.
- The live Anthropic path has been exercised on the happy path only, once, on 2026-11-16, and nothing needed fixing. `RUN_LIVE=1 npx vitest run test/live.test.ts` passed, and one typed Call with `npm run chat` went from the greeting through two Turns to the `goodbye` End state, with the closing message shown once. The API accepted `claude-sonnet-5-5`, adaptive thinking at `low` effort, the strict transition tool and the fallback beta. Each reply's first text came 1.6 to 2.2 s after the Caller's line and the reply was complete within 2.3 s. Still seen only against canned streams: a refusal, the server-side fallback taking over, a reply cut off at `max_tokens`, a tool call cut off mid-input, a failed or retried request, and a timeout. That typed Call was driven through pipes, so `npm run chat` has not been held with the real API on a real terminal (where a withdrawn reply is erased). `npm run test:live` as a whole has not been run, because its Voice half needs the ElevenLabs keys.
- The ElevenLabs path has never been exercised against the real service. `ElevenLabsVoice` is tested only against canned HTTP, `npm run talk` has run only against stand-ins (a local server for both APIs, and scripts in place of `afplay` and `ffmpeg`), the live Voice check in `npm run test:live` has never run, and no spoken Call has been held. Unconfirmed until then, among other things: whether `tag_audio_events` sent as the multipart string `false` is accepted, what comes back for silence, and whether the mp3 that the live check uploads as `application/octet-stream` is accepted (`npm run talk` uploads WAV).
- Ctrl-C outside a recording exits at once without stopping `afplay`, so a reply that is being played may carry on. Ctrl-C is tested on `openTalkTerminal`, not on the running program: `talk-cli.ts` passing `process.exit` as its `quit` has no test.
- An empty `apiKey` passed straight to the `ElevenLabsVoice` constructor garbles its redacted error messages. `fromEnv` rejects an empty key, so only direct construction is affected.
- Nothing expires a Call that is abandoned mid-way, since `InMemorySessionStore` has no TTL.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `bitlabsdevteam/AI_receptionist_claude_sdk`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
