# Proposal: a Telnyx voice channel for the Receptionist

> Issue #17 is the spec for this work and wins wherever the two differ. This proposal predates `npm run talk`, so where it says there is no `talk` script it is out of date.

Date: 2026-11-16. Status: proposed implementation, based on the current worktree and official Telnyx documentation. The API examples below have been checked against documentation; no Telnyx account changes, paid calls, or live speech tests were performed.

## Recommended approach

Use **Telnyx Call Control + Conversation Relay** for the phone connection, speech-to-text (STT), text-to-speech (TTS), and caller interruptions. Keep this repository's **FlowEngine and AnthropicModelClient** responsible for understanding the Caller, following the Flow, and enforcing business rules.

The integration is:

**Caller audio → Telnyx STT → text over WebSocket → FlowEngine → finalized reply over WebSocket → Telnyx TTS → Caller.**

Conversation Relay is specifically designed for an application that brings its own conversation logic. Telnyx opens one WebSocket to our server and exchanges transcripts, text for synthesis, interruption events, and keypad input. We do not need to transport or transcode audio for this approach. [Relay guide][1]

Start with **Deepgram Nova-3 through Telnyx** for recognition and **Telnyx Ultra** for speech, using the documented configuration below. Both speech operations go through Telnyx; Deepgram is the underlying STT provider in this configuration. If the requirement is specifically Telnyx-native STT, select `transcription_engine: "Telnyx"` with compatible model settings and compare its accuracy and endpointing on representative Calls before choosing it. Change the engine and model configuration together; do not leave a Deepgram model selected for the Telnyx engine. Provider/model availability differs between Relay, in-call commands, and standalone speech APIs. [Relay API][2] [STT engines][8]

This changes the first-adapter recommendation in [PRD.md](PRD.md) §8.6 and [TDD.md](TDD.md) §2. Their TeXML Gather approach remains an option, but Relay offers managed interruptions and a direct text connection to our existing Harness. The implementation should update those design decisions when this proposal is adopted.

| Approach | What we build | Best use |
|---|---|---|
| **Conversation Relay — recommended** | Call lifecycle, a text WebSocket adapter, Turn coordination, business logic | A capable Receptionist without maintaining an audio pipeline |
| Call Control `transcription_start` + `speak` | Transcript webhook handling, reply commands, our own turn-taking rules | A simpler sequential phone prototype or fallback |
| Media Streaming + standalone Telnyx STT/TTS | Audio transport, codec conversion, endpointing, playback buffering and cancellation | Custom VAD, audio processing, or tighter control justified by measurements |
| TeXML `<Gather input="speech">` + `<Say>` | HTTP handlers returning XML | A conventional request/response IVR; the current docs specify `speechTimeout` in seconds [Gather][12] |

## What can be reused

These observations come from code, rather than the older “built today” descriptions in the design documents.

| Current component | Reuse or required change |
|---|---|
| [FlowEngine](src/engine/engine.ts) | Reuse `start(callId, { callerNumber })` and `handleUser(callId, utterance, turnId)`. Turn results are idempotent by `turnId` within the stored Call. |
| [Flow and schema](src/flow/schema.ts), [current Flow](flows/receptionist.json) | Reuse Nodes, Edges, End states and configurable instructions. The current Flow only greets, converses, and ends; it explicitly cannot perform business actions. |
| [ModelClient](src/engine/model.ts) and [Anthropic client](src/engine/anthropic-client.ts) | Keep the text model seam. Add cancellation/deadlines and usage/timing reporting for production voice. |
| [ReplyStream](src/engine/reply-stream.ts) | Keep for provisional text display. It is **not a safe audio stream**: later refusal or failure can call `discard()`. |
| [Voice](src/voice/voice.ts), [ElevenLabsVoice](src/voice/elevenlabs.ts), [runTalk](src/adapters/talk.ts) | Local speech components already exist. `runTalk` correctly waits for the final reply before speaking. The current `package.json` has no `talk` script and the CLI runs `runChat`, so local speech is not fully wired through that entry point. |
| [SessionStore](src/engine/session.ts) | Reuse as a seam, but its current implementation is in memory and has no TTL or distributed locking. `start()` is not idempotent and does not use the per-Call Turn queue. |
| [TurnResult.actions](src/engine/turn.ts) | Reserved, currently always empty. Typed transfer and other business actions still need implementation. |

There is currently no HTTP/WebSocket phone server, Telnyx adapter, business-tool executor, identity Guard, or structured Trace implementation. Adding speech alone will not supply these capabilities.

## How to integrate Conversation Relay

### 1. Configure the phone entry point

Create or select a Telnyx Call Control application, assign the intended phone number to it, and configure its HTTPS webhook URL as `https://voice.example.com/webhooks/telnyx`. Deploy a Node 24 service with a public WSS route at `/telnyx/relay/:token`. Use a tunnel for development and a service with persistent WebSocket support for production. [Call Control webhooks][4] [Relay guide][1]

Suggested application configuration — these variables are **new**, except the existing Anthropic key and Flow path:

```dotenv
TELNYX_API_KEY=<server-side secret>
TELNYX_PUBLIC_KEY=<account webhook verification public key>
TELNYX_CONNECTION_ID=<Call Control application id>
PUBLIC_BASE_URL=https://voice.example.com
PUBLIC_WSS_BASE_URL=wss://voice.example.com
TELNYX_TTS_VOICE=Telnyx.Ultra.Callie
TELNYX_STT_ENGINE=Deepgram
TELNYX_STT_MODEL=deepgram/nova-3
VOICE_LANGUAGE=en-US
ANTHROPIC_API_KEY=<existing secret>
FLOW_PATH=flows/receptionist.json
```

English is an example configuration, not an assumed product requirement. Select the actual Caller language and voice using the supported catalog and listening tests. Keep API keys on the server; no Telnyx API key belongs in the WSS URL. [Available voices][13]

### 2. Answer and start Relay

For an inbound `call.initiated`, persist a Call record and issue `POST /v2/calls/{call_control_id}/actions/answer`. On `call.answered`, start Relay with the following documented request shape. All Call Control requests use `Authorization: Bearer <TELNYX_API_KEY>` and JSON. [Relay API][2]

Give the engine an internal `callId` and persist its mapping to Telnyx's `call_session_id`, `call_leg_id`, and `call_control_id`. Address commands to the correct leg; a transfer can introduce another leg without requiring a new Receptionist conversation.

```http
POST https://api.telnyx.com/v2/calls/{call_control_id}/actions/conversation_relay_start
```

```json
{
  "command_id": "891510ac-f3e4-11e8-af5b-de00688a4901",
  "url": "wss://voice.example.com/telnyx/relay/REPLACE_WITH_SINGLE_USE_TOKEN",
  "voice": "Telnyx.Ultra.Callie",
  "tts_provider": "telnyx",
  "voice_settings": { "type": "telnyx" },
  "language": "en-US",
  "transcription_engine": "Deepgram",
  "transcription_engine_config": {
    "transcription_model": "deepgram/nova-3"
  },
  "interruptible": "speech",
  "dtmf_detection": true
}
```

Generate and store a distinct command ID for each logical operation, reusing it only when retrying that operation. The example omits Relay's optional `greeting`: the engine should generate the greeting once and the adapter should send it after `setup`, avoiding two greetings. Only one AI Assistant or Conversation Relay can be active on a Call at a time. [Relay API][2]

### 3. Translate WebSocket messages into Turns

Telnyx initiates the connection to our server. This is different from our server opening an authenticated connection to the standalone STT/TTS APIs. [Relay guide][1]

| Incoming event | Adapter behavior |
|---|---|
| `setup` | Validate the connection token and match `callControlId`, `callSessionId`, and `callLegId` to the Call record. Bind `sessionId` to this Relay connection. Start the engine exactly once and send its final greeting. |
| `prompt` with `last: false` | Replace the provisional transcript; do not execute a Turn or a business tool. |
| `prompt` with `last: true` | Accept the nonempty `voicePrompt`, allocate a durable Turn ID, then call `handleUser`. Send its finalized reply if the Call and generation are still current. |
| `interrupt` | Record the played prefix from `utteranceUntilInterrupt`, invalidate pending output, and prepare to accept the new Caller Turn. Telnyx handles the configured interruption of TTS. |
| `dtmf` | Route digits through explicit code, for example `0` for a human or an ID/PIN collection mode. Avoid recording sensitive digits in Traces. |
| `error`, socket close, or `call.conversation.ended` | Reconcile Call state and run the configured recovery path. A broken Relay connection does not imply the phone Call has hung up. |
| `call.hangup` webhook | Mark the Call closed, abort work, clear timers/queues, and prevent late model results from recreating state or issuing commands. |

The actual transcript and reply messages are small: [Relay protocol][1]

```json
{ "type": "prompt", "voicePrompt": "What time do you open?", "lang": "en", "last": true }
```

```json
{ "type": "text", "token": "We open at nine tomorrow morning.", "last": true }
```

The reply above is only a protocol example; actual business hours must come from approved business data.

The core integration is the existing engine call:

```ts
// Sketch inside the validated, serialized Call worker.
// callId, text and turnId have already been persisted by the adapter.
const result = await engine.handleUser(callId, text, turnId);
// After checking the Call is active and this generation is still current:
// - normal reply: send { type: "text", token: result.reply, last: true }
// - ended reply: run the closing sequence below
```

A Relay `prompt` has no documented webhook event ID. Allocate IDs such as `<relay-session-id>:<accepted-turn-sequence>` at ingestion and retain them for internal retries. Do not deduplicate by transcript text: “yes” can be a legitimate answer on several Turns. WebSocket delivery also does not offer durable application acknowledgments, so this design must not claim exactly-once speech across a process crash. Recover with a known prompt or human handoff rather than blindly replaying an uncertain reply.

### 4. Finish without cutting off the goodbye

An `end` WebSocket frame ends **Relay**, not necessarily the phone Call; a `text` frame with `last: true` means text submission is complete, not that playback has finished. [Relay guide][1]

For an engine result with `ended: true`, do not send that final reply through Relay. Stop Relay using `POST /v2/calls/{call_control_id}/actions/conversation_relay_stop`, confirm it has ended, then send the **whole final `TurnResult.reply` once** through Call Control `speak`. Correlate its `call.speak.ended` event before issuing `hangup`. This preserves the engine's End state message and avoids truncating or doubling the goodbye. An explicit playback stop can also produce `call.speak.ended`, so distinguish cancellation from normal completion in our state. Add a bounded timeout and handle caller hangup at every step. [Relay stop][3] [Speak][6] [Stop playback][7]

For richer playback telemetry, the TeXML version of ConversationRelay documents `events="speaker-events tokens-played"`, including `agentSpeaking: off` at the end of playout. The current Call Control start schema does **not** expose an `events` field. Do not copy that TeXML attribute into a Call Control request or assume those events will arrive. [TeXML Relay][11] [Relay API][2]

## Make turn-taking natural without breaking the Harness

**First release: synthesize finalized replies.** Do not connect `ReplyStream.text()` directly to Relay or TTS. In this engine, a later Node can refuse and discard all earlier text from the Turn. Audio already heard cannot be withdrawn. TDD §11's suggestion that the existing stream can drive audio unchanged needs correction.

**Interruptions need two layers.** Telnyx can stop speech, but our application must also stop stale reasoning and output. Add a Call generation counter and an `AbortSignal` through `FlowEngine`, `ModelClient`, and the Anthropic request. On interruption, new superseding input, timeout, or hangup, invalidate the old generation. Check that generation before committing state, executing a business action, or sending output. A `Promise.race` timeout alone leaves the old work running and is insufficient.

Control events must be handled promptly while a model call is in progress; do not put hangup and interruption handling behind the model's awaiting Turn queue. Keep business-state mutation serialized, with explicit cancellation and guarded commit boundaries. A cancelled tool action may already have succeeded externally, so reconcile its stored operation ID instead of simply retrying it.

**Track generated text separately from what was heard.** The current transcript records a complete reply before playback. Add delivery metadata and construct model history using the known played prefix when an interruption occurs. Keep the original Turn result for idempotent replay. When playback completion is unknown, record that uncertainty; sending text is not proof the Caller heard it. This requires an engine/history change, not only a transport adapter.

**Optimize after measuring.** Keep replies short, ask one question at a time, and reduce unnecessary Edge hops. Later evaluate Deepgram Flux via Telnyx for end-of-Turn signals. With eager endpointing, `turnResumed` must cancel speculative work; speculative work must not advance the Flow or execute business actions. Early LLM speech requires a new irrevocable speech-commit contract, including rules for later refusals and errors. [Relay guide][1] [STT engines][8]

Suggested acceptance targets, **not measured performance or Telnyx guarantees**:

| Measurement | Initial target |
|---|---|
| Caller end of speech → first audible reply | p50 ≤ 1.5 s and p95 ≤ 3 s for a simple single-Node Turn |
| Caller interruption → Receptionist audio stops | p95 ≤ 300 ms, tested on real phone audio |
| Duplicate webhook processing | No repeated answer, greeting, tool action, or closing command |
| Model/tool failure | Bounded recovery with an honest fallback or human transfer; no indefinite silence |

Measure endpointing, queue wait, each model hop, tool duration, and speech start separately. The current Anthropic client allows a 20-second request timeout plus two retries, which is too long to serve as a voice Turn deadline. Set an explicit overall deadline and retry policy. A short preapproved waiting message can reduce uncertainty, but it must not claim that an action succeeded.

## Capabilities that make this a useful Receptionist

Speech is the channel; reliable actions make it useful. Build the following into the existing Flow and Harness:

1. **Trusted answers and routing.** Retrieve hours, location, policies, and services from an approved knowledge source. Route each Caller need to a clear Node and request clarification when confidence is low.
2. **Guarded business tools.** Implement a tool registry with schemas, per-Node allow-lists, authorization checks, deadlines, and operation IDs. Add account lookup, appointment availability, booking, or message-taking only when real integrations exist. Confirm important details before writes and report success only after a successful tool result.
3. **Identity verification when required.** Enforce `verified` in code before account-specific tools and Edges. Caller ID is a routing signal, not proof of identity. Normalize spoken digits and dates, confirm ambiguous details, and support keypad input.
4. **Human handoff.** Add a typed transfer action with allowed destinations, business hours, no-answer recovery, and a concise approved handoff summary. A warm transfer requires explicit second-leg/bridge handling; it is not achieved by the model saying “transferring you.” Telnyx provides transfer and bridge commands. [Call commands][17]
5. **Conversation quality.** Tune voice, pronunciation, language, silence timeouts, and interruption sensitivity with realistic Caller samples. Avoid fixed assumptions about accents or language based on phone number.
6. **Traces and evaluation.** Record redacted Turn timing, STT corrections, tool outcomes, interruption count, safe-line use, and handoff success. Evaluate task completion, not just transcription quality or whether the Receptionist sounds natural.

The current Flow's statements that it cannot book, transfer, or look up accounts should change only alongside the corresponding code and tested integrations.

## When to use direct Telnyx STT/TTS instead

### In-call commands

For a sequential implementation, use these commands against the active `call_control_id`: [Transcription start][5] [Speak][6] [Stop playback][7]

| Purpose | Endpoint or event |
|---|---|
| Start STT | `POST /v2/calls/{id}/actions/transcription_start` |
| Receive text | `call.transcription`; inspect `payload.transcription_data.transcript` and `is_final` |
| Speak a reply | `POST /v2/calls/{id}/actions/speak` with `payload`, `voice`, and a stored `command_id` |
| Observe TTS | `call.speak.started`, `call.speak.ended` |
| Interrupt synthesized speech | `POST /v2/calls/{id}/actions/playback_stop` — there is no documented `speak_stop` command |

Example native Telnyx STT request:

```json
{
  "transcription_engine": "Telnyx",
  "transcription_engine_config": {
    "transcription_engine": "Telnyx",
    "transcription_model": "openai/whisper-large-v3-turbo",
    "language": "en"
  },
  "transcription_tracks": "inbound",
  "command_id": "c4282e71-95a5-4ef7-91c0-bfc446a6f125"
}
```

This explicit native model is documented for in-call transcription. The standalone WebSocket engine table currently lists `openai/whisper-tiny` for Telnyx instead; do not copy the in-call model choice across interfaces without checking support. [Transcription start][5] [STT engines][8]

Example TTS request, also used by the recommended closing sequence:

```json
{
  "payload": "Thank you for calling. Goodbye.",
  "payload_type": "text",
  "voice": "Telnyx.Ultra.Callie",
  "command_id": "405c3427-4304-4ad1-9828-00c4240b57e9"
}
```

Select inbound audio for recognition so the Receptionist does not transcribe its own output. A final STT segment is not automatically a complete conversational Turn: the adapter still needs segmentation/endpointing rules. The `speak` payload is limited to 3,000 characters; enforce a sensible spoken-length limit and order any split playback. Stop/skip behavior must be checked with the selected speech queue. [Transcription start][5] [Speak][6]

### Standalone streaming speech and a custom audio bridge

The independent APIs are useful for a future local microphone implementation as well as custom phone audio:

| API | Connection |
|---|---|
| STT | `wss://api.telnyx.com/v2/speech-to-text/transcription` |
| TTS | `wss://api.telnyx.com/v2/text-to-speech/speech` |

Our server opens these connections with Bearer authentication. For example, Deepgram STT through Telnyx can accept raw telephony audio with `transcription_engine=Deepgram&model=nova-3&input_format=mulaw&sample_rate=8000`. STT receives **binary audio frames**, not the media bridge's base64 JSON envelope. Check engine-specific format support: native Telnyx STT does not accept raw μ-law in the current format table, so decode/resample to a supported format such as `linear16`. [STT lifecycle][9] [Audio formats][10]

For TTS, choose a documented streaming voice such as `Telnyx.KokoroTTS.af_heart`. Its PCM configuration is `audio_format=linear16&sample_rate=24000`; these bytes require conversion before PCMU telephony playback. Send `{"text":" "}` to initialize, then text frames with `flush: true` when a committed fragment should be synthesized. Decode returned base64 audio according to the provider's frame contract. `{"force":true}` restarts synthesis; it does **not** remove audio already queued on the phone leg. Standalone Ultra is documented as REST-only, even though Ultra is available for in-call playback and appears in Relay examples. [TTS streaming][14] [TTS messages][15] [Native TTS][16] [Kokoro configuration](https://developers.telnyx.com/docs/voice/tts/providers/telnyx/kokoro)

For a phone bridge, add Call Control `streaming_start` with bidirectional media. Read the actual negotiated format from stream metadata, convert TTS output to the outbound codec/sample rate, and pace playback with bounded queues. On interruption, invalidate synthesis and clear the phone playback queue. Use playback marks to track completion, distinguishing normal marks from marks released by a clear. A synthesizer's final frame is not evidence that the Caller heard the audio. [Media streaming][18]

Do not run Relay and a second STT/TTS audio loop for the same Call. Select one speech owner. A custom audio bridge is a separate engineering investment, justified when Relay cannot meet a measured requirement.

## Implementation plan

Suggested files are additions, not claims about existing functionality. Fastify with WebSocket support is a reasonable server choice; keep provider parsing and business decisions independently testable.

| Phase | Work | Completion evidence |
|---|---|---|
| 1. Phone connection | `src/adapters/http.ts`, `src/telnyx/client.ts`, webhook verification and schemas, a command ledger, Call startup coordination | Signed duplicate/reordered webhook fixtures cause one answer and Relay start; a controlled Call reaches the engine's greeting |
| 2. Text Relay | `src/adapters/telnyx-relay.ts`, a Call coordinator, setup/prompt/reply/DTMF mapping, the closing sequence | Real Caller speech reaches `handleUser`; final replies are spoken; goodbye finishes before hangup |
| 3. Natural Turns | Generation-aware cancellation, history delivery metadata, silence and failure policy, Turn deadlines | Interruptions and hangups suppress stale output and state writes; no provisional/refused model text is spoken |
| 4. Useful actions | Tool registry, Guards, approved knowledge, selected business integration, transfer policy | The target Caller task completes against the real integration; unsupported or unauthorized actions cannot run |
| 5. Production service | Durable Call state, distributed coordination, redacted Traces, dashboards, recovery and load testing | Restart, concurrent Calls, provider failures, retention, and cost/latency targets pass an explicit release check |

A durable store alone is not enough for multiple workers: `SessionStore.get/put` provides no atomic update or lock. Add a per-Call owner/lease and versioned commits, plus a durable inbox/outbox for HTTP events and commands. Treat relay sockets as owned by a worker and define what happens when that worker dies. Keep terminal chat and its existing offline tests working.

Use Vitest and fake model/transport implementations for duplicate startup, repeated final prompts through internal retries, partial transcripts, delayed commands, cancellation, refused/empty output, queue clearing, tool idempotency, and hangup during every stage. Run `npm run typecheck` and `npm test` after implementation. Live phone tests should cover accents/noise, silence, a mid-sentence interruption, an Edge hop, a tool failure, a failed transfer, and a socket loss. The present `npm run test:live` exercises Anthropic and ElevenLabs; it does not validate Telnyx.

## Reliability, deployment, and cost

Validate HTTP webhook signatures over the exact raw request body using the account public key and `telnyx-signature-ed25519` / `telnyx-timestamp`; enforce a replay window. Persist the event ID and enqueue accepted work, then return `200` promptly. Do not await the model inside the webhook request. Events can arrive duplicated or out of order. Telnyx command deduplication is time-bounded, so also retain our own command ledger. [Webhook verification][19] [Call Control webhooks][4]

The reviewed Relay documentation does not specify a verifiable WebSocket handshake signature scheme. Bind each connection to a short-lived, single-use random token issued for a validated Call, compare setup identifiers, exclude URL tokens from access logs, and reject unknown or extra connections. Verify the provider-supported handshake contract during the connection test; do not assume a media-stream authentication scheme applies to Relay.

Relay does not automatically reconnect after its WebSocket closes. On unexpected `call.conversation.ended`, reconcile whether the phone Call is still active and take a bounded recovery path: a controlled Relay restart or a short Call Control prompt and transfer. Never interpret `reason: "customer_disconnect"` alone as Caller hangup; the guide uses it for our WebSocket disconnect. A failed transfer needs its own no-answer fallback. [Relay guide][1]

Run the service near the relevant telephony/speech infrastructure and measure the complete Telnyx → application → Anthropic path before selecting a region. Configure proxy idle timeouts for persistent WebSockets, admission limits, and graceful draining. Track active Calls, Turn latency, disconnects, failed commands, and spend. Redact transcript/identity data before logging and define retention; this repo's proposed identity and PII Guards still need to be built.

Budget per Call as:

`telephony + Relay or media fees + separately billed STT/TTS + Anthropic tokens + tools/storage/hosting + allocated number rental`.

The published rate deck currently lists Conversation Relay at **$0.05/minute**, Voice API at **$0.002/minute plus SIP**, and WebSocket media streaming at **$0.0035/minute**. A three-minute Call therefore has a **$0.15 Relay line item**, not a proven $0.15 total cost. Confirm which speech/telephony charges Relay includes for the account before adding line items. The separate hosted Voice AI bundled price is not evidence that our custom Anthropic backend is included. [Pricing][20]

For direct speech, the same pricing page lists native Telnyx STT at **$0.015/minute**, generic Telnyx TTS at **$0.000006/character**, and Ultra at **$0.000032/character**. Rates vary by model and product; do not price Ultra at the generic TTS rate or apply a Call Control rate unverified to standalone STT. Record actual usage and reconcile the first controlled Calls against billing. No measured latency, final monthly estimate, or account-specific quota is asserted by this proposal.

## Official sources

Reviewed on 2026-11-16. Where tutorial examples and API schemas differ, prefer the endpoint schema and verify the exact combination in a controlled integration test.

- [1 — Conversation Relay guide][1]
- [2 — Start Conversation Relay API][2]
- [3 — Stop Conversation Relay API][3]
- [4 — Call Control webhooks][4]
- [5 — Start in-call transcription][5]
- [6 — Speak text][6]
- [7 — Stop audio playback][7]
- [8 — STT engines and models][8]
- [9 — Standalone STT WebSocket lifecycle][9]
- [10 — STT audio formats and engine compatibility][10]
- [11 — TeXML ConversationRelay, including playback events][11]
- [12 — TeXML Gather][12]
- [13 — Available TTS voices][13]
- [14 — Standalone TTS WebSocket lifecycle][14]
- [15 — TTS WebSocket messages][15]
- [16 — Native Telnyx TTS providers][16]
- [17 — Call Control command catalog][17]
- [18 — Media streaming][18]
- [19 — Webhook verification and delivery contract][19]
- [20 — Published pricing and detailed rate deck][20]

[1]: https://developers.telnyx.com/docs/voice/programmable-voice/conversation-relay
[2]: https://developers.telnyx.com/api-reference/call-commands/start-conversation-relay
[3]: https://developers.telnyx.com/api-reference/call-commands/stop-conversation-relay
[4]: https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks
[5]: https://developers.telnyx.com/api-reference/call-commands/transcription-start
[6]: https://developers.telnyx.com/api-reference/call-commands/speak-text
[7]: https://developers.telnyx.com/api-reference/call-commands/stop-audio-playback
[8]: https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters/engines-and-models
[9]: https://developers.telnyx.com/docs/voice/stt/websocket-streaming
[10]: https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters/audio-formats
[11]: https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/conversationrelay
[12]: https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/gather
[13]: https://developers.telnyx.com/docs/voice/tts/available-voices
[14]: https://developers.telnyx.com/docs/voice/tts/websocket-streaming
[15]: https://developers.telnyx.com/docs/voice/tts/websocket-streaming/messages
[16]: https://developers.telnyx.com/docs/voice/tts/providers/telnyx
[17]: https://developers.telnyx.com/public/llms/calling/voice-api.txt
[18]: https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming
[19]: https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks
[20]: https://telnyx.com/pricing.md
