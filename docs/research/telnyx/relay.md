# Telnyx: connecting call speech to an application that owns the conversation (text in, text out)

Date fetched: 2026-11-16. Every page was fetched that day as raw Markdown (Telnyx serves `<doc URL>.md`) or as the published file named. The raw copies were not kept.

Tags: `[quoted: URL]` = the words in quotation marks (or the code value) are verbatim from that URL. `[inferred]` = my reading of what the docs imply, not stated by Telnyx. `[unverified]` = not confirmed by any Telnyx page I fetched.

Short names used in tags (all under `https://developers.telnyx.com` unless a full URL is given):

- GUIDE = https://developers.telnyx.com/docs/voice/programmable-voice/conversation-relay.md
- VERB = https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/conversationrelay.md
- CONNECT = https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/connect.md
- START = https://developers.telnyx.com/api-reference/call-commands/start-conversation-relay.md
- STOP = https://developers.telnyx.com/api-reference/call-commands/stop-conversation-relay.md
- SPEC = https://raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json (last commit to that file 2026-11-12, per the GitHub API)
- EVENTS = https://developers.telnyx.com/data/webhook-events.json
- RELNOTE = https://telnyx.com/release-notes/conversation-relay-stream-text-websockets.md
- PRODUCT = https://telnyx.com/products/conversation-relay
- PRICE-VOICE = https://telnyx.com/pricing/voice-api.md
- PRICE-AI = https://telnyx.com/pricing/voice-ai-agents.md
- PRICE-ALL = https://telnyx.com/pricing.md

---

## 1. Is there a Telnyx "Conversation Relay"? Status, date, the two ways to start it

**It exists, as a Telnyx feature of its own.**
- "Conversation Relay connects a live Telnyx call to your WebSocket application. Telnyx handles speech recognition and text-to-speech while your application receives caller input and sends commands back in real time." [quoted: GUIDE]
- Telnyx positions it as the way to keep your own model: "If you want your own server to replace the LLM entirely, use [ConversationRelay]... instead." [quoted: https://developers.telnyx.com/docs/inference/ai-assistants/conversation-event-stream.md]
- "Bring your own AI engine: Use Telnyx phone numbers, Voice API, TTS, and STT while connecting to your own AI engine for reasoning and logic." [quoted: RELNOTE]

**Status.**
- Release note title and date: "Conversation Relay is now available on Telnyx", "8, Jun 2026". [quoted: RELNOTE]
- The words "GA", "general availability", "beta" and "preview" do not appear in the release note, the guide, the verb page or the API reference page (I searched each). [inferred: no status label is published]
- Other Telnyx features in the same docs are explicitly labelled, for example Delegation ("**Beta.** Configure delegation with `delegation_settings`") [quoted: https://developers.telnyx.com/docs/inference/ai-assistants/delegation.md] and "Noise Suppression Start (BETA)". So the absence of a label suggests it is treated as generally available. [inferred]
- A search-engine summary claimed the release note says "general availability" and describes a `stream_bidirectional_mode: text` parameter. Neither is in the page as fetched, and the spec's `StreamBidirectionalMode` enum is only `["mp3", "rtp"]`. [quoted: SPEC] Treat both claims as [unverified].

**Two ways to start it (three, counting the embedded form).**
- TeXML: "return a `<Connect>` verb with a nested `<ConversationRelay>` verb from your TeXML voice URL." [quoted: GUIDE]
- Call Control: "send a `conversation_relay_start` command with the call's `call_control_id`", endpoint `POST https://api.telnyx.com/v2/calls/{call_control_id}/actions/conversation_relay_start`. [quoted: GUIDE]
- Embedded in `answer` and `dial` as `conversation_relay_config`: "Starts a Conversation Relay session automatically when the answered/dialed call is answered. This embedded shape is supported on `answer` and `dial`." [quoted: SPEC, schema `ConversationRelayEmbeddedConfig`]. This form is in the spec only; the guide does not mention it.

**How the two differ (documented surface only).**

| Capability | TeXML `<ConversationRelay>` | Call Control `conversation_relay_start` |
|---|---|---|
| Greeting | `welcomeGreeting` [quoted: VERB] | `greeting` [quoted: START] |
| Greeting barge-in | `welcomeGreetingInterruptible` [quoted: VERB] | `interruptible_greeting` (also `interruption_settings.welcome_greeting_interruptible`) [quoted: START] |
| Custom data | child `<Parameter name value>` [quoted: VERB] | `custom_parameters` object [quoted: START] |
| `events` (`speaker-events`, `tokens-played`) | Yes [quoted: VERB] | Not in the request schema. Property list is: `conversation_relay_settings, url, dtmf_detection, conversation_relay_url, conversation_relay_dtmf_detection, voice, voice_settings, greeting, language, languages, interruption_settings, transcription, assistant, client_state, command_id, tts_provider, provider, structured_provider, transcription_engine, transcription_engine_config, interruptible, interruptible_greeting, custom_parameters` [quoted: SPEC] |
| Partial prompts | `partialPrompts="true"` with `speechModel="flux"` [quoted: VERB] | `transcription_engine_config.interim_results` and `eager_eot_threshold` [quoted: GUIDE] |
| End-of-turn thresholds | None documented [inferred] | `eot_threshold`, `eager_eot_threshold` [quoted: START] |
| TTS provider settings (`voice_settings`, ElevenLabs key ref) | None documented. `apiKeyRef` on the verb is for the STT engine only; `ttsProvider` exists only on `<Language>` [quoted: VERB] | `voice_settings`, `tts_provider`, `provider` + `structured_provider` [quoted: START] |
| Background audio | `backgroundAudioType` / `backgroundAudioValue` [quoted: VERB] | Not in the schema [inferred] |
| Community STT engine | `apiKeyRef` + a registered engine name [quoted: VERB] | Enum only: `Google, Telnyx, Deepgram, Azure, xAI, AssemblyAI, Speechmatics, Soniox, A, B` [quoted: START] |
| Idempotency / state | None | `command_id`, `client_state` [quoted: START] |
| What happens after | Next TeXML verbs, or `<Connect action>` callback [quoted: GUIDE] | `call.conversation.ended` webhook [quoted: START] |
| Stop from outside the socket | Not documented [inferred] | `conversation_relay_stop` [quoted: STOP] |
| Session id returned | Not documented | `conversation_relay_id` in the 200 response [quoted: START] |

The WebSocket frames are documented once, in the guide, for both. [inferred]

---

## 2. The WebSocket protocol

**Who opens it.** "Telnyx opens a WebSocket connection to your application." "Your application provides a public `wss://` WebSocket URL." [quoted: GUIDE] The URL "must start with `ws://` or `wss://`" (pattern `^wss?://`). [quoted: START]

**One socket per session.** "Conversation Relay uses a single bidirectional WebSocket connection per session". [quoted: GUIDE]

### Telnyx to application

| `type` | Fields (as documented) | Notes |
|---|---|---|
| `setup` | `sessionId`, `accountSid`, `callSid`, `callControlId`, `callSessionId`, `callLegId`, `from`, `to`, `direction`, `callerName`, `callStatus`, `customParameters` [quoted: GUIDE] | "First frame sent after the WebSocket connects. Identifies the relay session and call." [quoted: GUIDE] In the example `callSid` and `callControlId` hold the same value. [quoted: GUIDE] |
| `prompt` | `voicePrompt`, `lang`, `last` [quoted: GUIDE] | "Partial transcripts use `last: false`; final transcripts use `last: true`." [quoted: GUIDE] |
| `eagerEndOfTurn` | `voicePrompt`, `lang` [quoted: GUIDE] | "The caller has likely finished speaking. Sent before the final `prompt` when partial prompts are on." "`voicePrompt` is the transcript the final prompt is expected to match" [quoted: GUIDE] |
| `turnResumed` | none [quoted: GUIDE] | "Sent if the caller keeps talking after an `eagerEndOfTurn`. Discard any reply prepared for it" [quoted: GUIDE] |
| `dtmf` | `digit` [quoted: GUIDE] | Only "When DTMF detection is enabled". [quoted: GUIDE] |
| `interrupt` | `utteranceUntilInterrupt`, `durationUntilInterruptMs` [quoted: GUIDE] | "Sent when the caller interrupts ongoing TTS playback." [quoted: GUIDE] The two fields appear only in the example (`"Welcome to Telnyx, how can I help"`, `1820`); neither is described. |
| `error` | `description` [quoted: GUIDE] | "Sent when your application sends an invalid frame or another relay error occurs." Example: `"Invalid message: missing required field: token"`. "After repeated invalid frames, Telnyx can close the WebSocket connection." [quoted: GUIDE] |
| `info` (opt-in, TeXML `events` only) | `name`, `value` [quoted: VERB] | `{"type": "info", "name": "agentSpeaking", "value": "on"}`, `{"type": "info", "name": "tokensPlayed", "value": "Hi."}`, `{"type": "info", "name": "agentSpeaking", "value": "off"}`, `{"type": "info", "name": "clientSpeaking", "value": "on"}` / `"off"` [quoted: VERB] |

Partial prompts need Deepgram Flux: "Partial prompts are supported with Deepgram Flux (`speechModel="flux"`)." [quoted: VERB] "The turn ends with a `prompt` frame with `last: true`. If its text matches the last `eagerEndOfTurn`, you can use the reply you prepared." [quoted: GUIDE]

The guide's table of Telnyx frames lists `setup, prompt, eagerEndOfTurn, turnResumed, dtmf, interrupt, error` and omits `info`; `info` is documented only on the verb page. [inferred from comparing GUIDE and VERB]

### Application to Telnyx

| `type` | Fields | Notes |
|---|---|---|
| `text` | `token`, `last` [quoted: GUIDE] | "The text content is sent in the `token` field." "For streaming LLM output, send each token or chunk with `last: false`, then send the final chunk with `last: true`". "If you omit `last`, Telnyx treats it as `false`. Send `last: true` when the turn is complete." [quoted: GUIDE] No `lang`, `interruptible` or `preemptible` field is documented for `text`. [inferred] |
| `play` | `source`, `loop`, `interruptible`, `preemptible` [quoted: GUIDE] | "Audio URL to play into the call." Example source is an `.mp3`. The fields are shown in one example and not described. [quoted: GUIDE] |
| `sendDigits` | `digits` [quoted: GUIDE] | "Valid characters are `0`-`9`, `A`-`D`, `w` or `W` for a pause, `#`, and `*`." [quoted: GUIDE] |
| `language` | `ttsLanguage`, `transcriptionLanguage` [quoted: GUIDE] | "At least one of `ttsLanguage` or `transcriptionLanguage` must be provided." [quoted: GUIDE] |
| `end` | `handoffData` [quoted: GUIDE] | "Send an `end` frame to end the Conversation Relay session gracefully". Example value is a JSON string: `"{\"reason\":\"caller_done\"}"`. [quoted: GUIDE] |

There is no `clear` frame, no way to cancel queued speech, and no way to stop a `play`, in either the guide or the verb page. [inferred from absence] (Raw media streaming does have one: "Sending a clear message will immediately stop the media playing on the stream and clear the media queue." [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming.md] That is a different feature.)

### Ordering

- `setup` is first: "First frame sent after the WebSocket connects." [quoted: GUIDE]
- `eagerEndOfTurn` is "Sent before the final `prompt`". [quoted: GUIDE]
- Nothing else is guaranteed. The docs do not say whether `interrupt` arrives before or after the `prompt` that caused it, whether `text` frames sent after an `interrupt` belong to a new turn, or how `tokensPlayed` is ordered against `agentSpeaking off`. [inferred from absence] The verb page's example sequence is `agentSpeaking on`, `tokensPlayed`, `agentSpeaking off`. [quoted: VERB]

### End of playback, and how much the caller heard

- "`agentSpeaking` brackets each agent turn (`on` at the start, `off` at true end-of-playout); `clientSpeaking` brackets caller speech." [quoted: VERB]
- "`tokensPlayed` carries the text that was played over TTS." [quoted: VERB]
- Both are opt-in through the TeXML `events` attribute: "When omitted, none of these messages are sent." [quoted: VERB] There is no equivalent parameter on the Call Control command (see section 1), so with Call Control there is no documented end-of-playback signal at all. [inferred]
- On barge-in, `interrupt.utteranceUntilInterrupt` and `durationUntilInterruptMs` are the only documented statement of what was said before the caller cut in. [quoted: GUIDE] Whether the text is exact to the word, or counts synthesised rather than played audio, is not stated. [unverified]
- `events` gotcha: "`events` is **space-separated**. Do not use commas — `events="speaker-events,tokens-played"` is treated as a single unrecognized token and no messages are sent." [quoted: VERB]
- Lead, not a fact: a web search surfaced third-party GitHub pull requests (DialogWright/dialogwright #36 and #45) reporting that `tokensPlayed` and `agentSpeaking` follow the TTS pipeline rather than the audio the caller heard. I did not fetch them and they are not Telnyx sources. [unverified]

### Socket drop and reconnection

"Telnyx does not reconnect automatically if the WebSocket closes. Closing the WebSocket terminates the Conversation Relay session." [quoted: GUIDE] "If your WebSocket disconnects, the webhook payload `reason` is `customer_disconnect`." [quoted: GUIDE] What the call does next (stays up silent, or hangs up) is not stated for Call Control. [unverified] For TeXML the next verb or the `action` callback runs (section 5).

### Authentication of the handshake

- Nothing. Neither the guide, the verb page nor the API reference mentions a signature, a header, a token or any verification for the relay socket. [inferred from absence; I searched all three for auth, signature, header, verify]
- Telnyx does sign two neighbouring sockets, which shows the gap is specific to the relay docs:
  - Media streaming: "Telnyx signs every media stream WebSocket connection... Each connection request includes two headers: `telnyx-signature-ed25519`... `telnyx-timestamp`... The signature covers the string `{telnyx-timestamp}|{stream_url}`". [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming.md]
  - Assistant event stream: `auth_ref` is "An integration secret whose value Telnyx sends as `Authorization: Bearer <value>` on the upgrade request." [quoted: https://developers.telnyx.com/docs/inference/ai-assistants/conversation-event-stream.md]
- Whether the relay socket carries the same Ed25519 headers is [unverified]. It must be tested on a live call.
- What an adapter can rely on today: a secret in the URL's query string (the URL is passed through as given) [inferred], and checking `setup.callControlId` against a call the application itself answered [inferred].
- HTTP webhooks (including `call.conversation.ended`) are signed: "This webhook uses Telnyx headers (telnyx-timestamp, telnyx-signature-ed25519)". [quoted: https://developers.telnyx.com/api-reference/callbacks/call-conversation-ended.md]

### Custom parameters

- TeXML: `<Parameter>` "Sends custom key-value data to your WebSocket server in the `setup` frame." [quoted: GUIDE] Example result: `"customParameters": { "customer_id": "customer_123" }`. [quoted: GUIDE]
- Call Control: `custom_parameters` are "Custom key-value parameters forwarded to the relay session as `assistant.dynamic_variables`. If `assistant.dynamic_variables` is also present, these values are merged in." [quoted: START] `assistant.dynamic_variables` values are typed as strings. [quoted: START]
- They arrive in `setup`, which is after the socket is accepted, so they cannot be used to refuse the upgrade. [inferred]

---

## 3. The start request

### Call Control

Endpoint: `POST https://api.telnyx.com/v2/calls/{call_control_id}/actions/conversation_relay_start`, Bearer API key. [quoted: START]

"A WebSocket URL is required: provide it as `url`, `conversation_relay_url`, or `conversation_relay_settings.url`; top-level values take precedence over nested settings." [quoted: START]

| Parameter | Type / values | Default | Quote |
|---|---|---|---|
| `url` | string, `^wss?://` | required (one of three spellings) | "Public alias for `conversation_relay_url`... If both are present, this value wins." [quoted: START] |
| `conversation_relay_url` | string | | "WebSocket URL for your Conversation Relay server." [quoted: START] |
| `conversation_relay_settings` | object: `url` (required), `dtmf_detection`, `interruptible`, `interruptible_greeting`, `languages` | | "Top-level aliases override nested values when both are present." [quoted: START] |
| `greeting` | string | none | "Text played when the relay session starts." [quoted: START] |
| `voice` | string | `Telnyx.KokoroTTS.af` | see voices below [quoted: START] |
| `voice_settings` | one of `elevenlabs, telnyx, aws, minimax, azure, resemble, inworld, xai, soniox` (discriminator `type`) | | "The settings associated with the voice selected" [quoted: START] |
| `tts_provider` | string | derived | "If omitted, Telnyx derives it from `voice` or `provider`." [quoted: START] |
| `provider` + `structured_provider` | string + free-form object | | "Structured voice provider. Must be supplied together with `structured_provider`." Example `{voice_id, model_id}`. [quoted: START] |
| `language` | string | `en` | "Default language for the relay session. This value is used for both text-to-speech and speech recognition." [quoted: START] |
| `languages[]` | `language` (required, "BCP 47 language tag"), `tts_provider`, `voice`, `voice_settings`, `transcription_engine`, `transcription_engine_config`, `transcription_provider`, `speech_model` | | "Per-language TTS and transcription settings." [quoted: START] |
| `transcription_engine` | `Google, Telnyx, Deepgram, Azure, xAI, AssemblyAI, Speechmatics, Soniox, A, B` | `Google` | "Legacy values `A` - `Google`, `B` - `Telnyx` are supported for backward compatibility." [quoted: START] |
| `transcription_engine_config` | object, extra keys allowed | | "accepts the same provider-specific options used by the Call Transcription Start command, such as `transcription_model`" [quoted: START] |
| `transcription_engine_config.interim_results` | boolean | `false` | "Deepgram Flux: send interim transcripts as `prompt` frames with `last: false`." [quoted: START] |
| `transcription_engine_config.eot_threshold` | number 0.5 to 0.9 | `0.7` | "Deepgram Flux: confidence required to end the caller's turn." [quoted: START] |
| `transcription_engine_config.eager_eot_threshold` | number 0.3 to 0.7 | unset | "confidence at which an `eagerEndOfTurn` frame is sent before the final prompt... When omitted, these frames are not sent." [quoted: START] |
| `transcription` | object | deprecated | "Not supported for Conversation Relay start requests. Use `transcription_engine` and `transcription_engine_config` instead." [quoted: START] |
| `interruptible` | `none, any, speech, dtmf` | `any` | "`any` allows speech or DTMF interruptions; `none` disables interruptions; `speech` allows speech only; `dtmf` allows DTMF only." [quoted: START] |
| `interruptible_greeting` | same enum | `any` | [quoted: START] |
| `interruption_settings` | `enable` (boolean), `interruptible`, `interruptible_greeting`, `welcome_greeting_interruptible` | | "`enable`: Legacy boolean form. `true` is equivalent to `interruptible=any`; `false` is equivalent to `interruptible=none`." [quoted: START] |
| `dtmf_detection` | boolean | `false` | "Public alias for `conversation_relay_dtmf_detection`." [quoted: START] |
| `custom_parameters` | object | | see section 2 [quoted: START] |
| `assistant.dynamic_variables` | object of strings | | "Custom key-value parameters forwarded to the Conversation Relay session." [quoted: START] |
| `client_state` | base64 string | | "Use this field to add state to subsequent webhooks." [quoted: START] |
| `command_id` | string | | "Telnyx will ignore any command with the same `command_id` for the same `call_control_id`." [quoted: START] |

Response: `{"data": {"result": "ok", "conversation_relay_id": "..."}}`. [quoted: START]

Not present anywhere in the request: a silence or no-input timeout, a hints list at the top level, a text-length limit, an `events` switch, a maximum session length. [inferred from absence] Hints exist only as engine options passed through `transcription_engine_config`: Deepgram Nova-3 and Flux `keyterms` ("Up to 100 domain-specific terms or brand names"), Nova-3 `keywords_boosting`, Google `hints` and `speech_context`. [quoted: SPEC, schemas `DeepgramFluxConfig`, `DeepgramNova3Config`, `TranscriptionEngineGoogleConfig`] That those pass through to the relay follows from "accepts the same provider-specific options used by the Call Transcription Start command" [quoted: START] but no relay example shows it. [inferred]

Supported combinations: none are stated. The docs give examples only (Telnyx voice + Deepgram `deepgram/nova-3`; Flux for partial prompts). [inferred]

### TeXML `<ConversationRelay>` attributes

`url`; `welcomeGreeting`; `voice` ("e.g., `Telnyx.Natural.abbie`, `Telnyx.NaturalHD.astra`"); `language` ("e.g., `en`, `fr`, `es`"); `transcriptionProvider` (alias `transcriptionEngine`; "e.g., `deepgram`"); `speechModel` ("e.g., `flux`"); `apiKeyRef` ("Reference to the API key the speech-to-text engine is called with... Required with a community engine."); `interruptible` and `welcomeGreetingInterruptible` (options `none, any, speech, dtmf, true, false`, default `any`); `dtmfDetection` (default `false`); `events`; `partialPrompts` (default `false`); `backgroundAudioType` (`media_url`) with `backgroundAudioValue`. [quoted: VERB]

Child `<Language>`: `code`, `ttsProvider` ("e.g., `telnyx`, `google`"), `voice`, `transcriptionProvider` / `transcriptionEngine`, `speechModel` ("e.g., `nova-2`"), `apiKeyRef` ("not inherited from the verb"), `backgroundAudioType`, `backgroundAudioValue`. Child `<Parameter>`: `name`, `value`. [quoted: VERB]

No default is documented for `voice`, `language` or the STT provider on the verb (the table shows `-`). [quoted: VERB]

### TTS providers and voices

- Voice string formats, from the `voice` parameter: `AWS.Polly.<VoiceId>` (append `-Neural`); `Azure.<VoiceId>`; `ElevenLabs.<ModelId>.<VoiceId>` ("The `ModelId` part is optional"); `Telnyx.<model_id>.<voice_id>`; `Inworld.<ModelId>.<VoiceId>` (models `Mini`, `Max`, `TTS2`); `FishAudio.<ModelId>.<VoiceId>`; `Soniox.<ModelId>.<VoiceId>`; `xAI.<VoiceId>`; `Humain.<VoiceId>`. [quoted: START]
- Telnyx's own models: KokoroTTS, Qwen3TTS, Ultra, Grok, Bayan, Sukhan. [quoted: https://developers.telnyx.com/docs/voice/tts/providers/telnyx.md] The relay guide's own examples use `Telnyx.Ultra.Callie`. [quoted: GUIDE]
- Full list: `GET https://api.telnyx.com/v2/text-to-speech/voices`. [quoted: https://developers.telnyx.com/docs/voice/tts/available-voices.md]

**ElevenLabs needs your own key, stored in Telnyx as an integration secret.**
- "To use ElevenLabs, you must provide your ElevenLabs API key as an integration secret under `"voice_settings": {"api_key_ref": "<secret_id>"}`." [quoted: START]
- `api_key_ref`: "The `identifier` for an integration secret... that refers to your ElevenLabs API key. Warning: Free plans are unlikely to work with this integration." [quoted: START]
- "ElevenLabs requires your own API key configured in your Telnyx account. Telnyx relays requests to the ElevenLabs API". "`voice_id` is a voice from **your own ElevenLabs account**". [quoted: https://developers.telnyx.com/docs/voice/tts/providers/elevenlabs.md]
- Secret creation: `POST /v2/integration_secrets` with `identifier`, `type` (`bearer` or `basic`), `token` ("Required for bearer type secrets"). [quoted: https://developers.telnyx.com/api-reference/integration-secrets/create-a-secret.md]
- "only a premium ElevenLabs can be used for the integration. The freemium account is not supported". "response latency may exceed what you'd see from AWS Polly or Azure AI Speech." [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/tts.md]
- Billing: "ElevenLabs TTS | BYO API key (billed by ElevenLabs)". [quoted: PRICE-VOICE]
- TeXML: the `<ConversationRelay>` verb has no attribute for a TTS key reference, so ElevenLabs through the TeXML form is undocumented. [inferred] (`<Say>` has `api_key_ref`. [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/tts.md])
- Azure can also take your own key: `api_key_ref` plus `region` ("Required when using a custom API key"). [quoted: START]

### STT engines and end-of-turn controls

- Engines accepted by the command: `Google, Telnyx, Deepgram, Azure, xAI, AssemblyAI, Speechmatics, Soniox`. Default `Google`. [quoted: START]
- Deepgram models in the spec: `deepgram/nova-2`, `deepgram/nova-2-medical`, `deepgram/nova-2-phonecall`, `deepgram/nova-3`, `deepgram/nova-3-medical`, `deepgram/flux`, `deepgram/flux-multi`. [quoted: SPEC, `TranscriptionEngineDeepgramConfig`]
- Flux: "Purpose-built for voice agents. Lowest latency with built-in end-of-turn detection... English only." `flux-multi`: 10 languages. [quoted: https://developers.telnyx.com/docs/voice/stt/models.md]
- Telnyx engine models: `openai/whisper-tiny` (default), `openai/whisper-large-v3-turbo`. [quoted: SPEC, `TranscriptionEngineTelnyxConfig`]
- End-of-turn controls documented for the relay: `eot_threshold` and `eager_eot_threshold`, Flux only (table above). [quoted: START]
- Nova-3 has `utterance_end_ms` ("Number of milliseconds of silence to consider an utterance ended. Ranges from 0 to 5000 ms.", default 1000) in the transcription-start schema. [quoted: SPEC, `DeepgramNova3Config`] Whether the relay honours it is [unverified].
- `eot_timeout_ms` ("Maximum silence in ms (`500`–`10000`) before forcing `EndOfTurn`", default 5000) is documented for the standalone STT socket [quoted: https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters/end-of-turn.md] and for AI Assistants, but not for the relay. [unverified for the relay]
- How the relay decides a turn has ended with a non-Flux engine (what makes a `prompt` `last: true`) is not documented. [unverified]

---

## 4. Interruption (barge-in)

- Configured by `interruptible` (speech in general) and `interruptible_greeting` / `welcomeGreetingInterruptible` (the greeting), values `none | any | speech | dtmf`, default `any`. [quoted: START] [quoted: VERB]
- "Use `welcomeGreetingInterruptible="none"` to ensure the greeting plays fully before accepting input." [quoted: VERB]
- What the application is told: an `interrupt` frame, "When the caller barges in over TTS playback", with `utteranceUntilInterrupt` and `durationUntilInterruptMs`. [quoted: GUIDE] With TeXML `events="speaker-events"` it also gets `clientSpeaking on/off`. [quoted: VERB]
- What Telnyx does to queued speech: not stated. The docs never say that playback stops, that buffered `text` frames are dropped, or that later frames of the same turn are discarded. [inferred from absence] The product page lists "DTMF, interruption, and call control" under "Telnyx handles". [quoted: PRODUCT]
- `play` frames carry their own `interruptible` and `preemptible` flags, undescribed. [quoted: GUIDE] `text` frames have neither. [inferred]
- No sensitivity, minimum-duration or minimum-word setting exists for barge-in. [inferred from absence]
- The application cannot interrupt its own speech: there is no `clear`. [inferred from absence]

---

## 5. Ending

**Stopping the relay (three ways).**
1. `end` frame: "Send an `end` frame to end the Conversation Relay session gracefully". [quoted: GUIDE]
2. Call Control: `POST /v2/calls/{call_control_id}/actions/conversation_relay_stop`, "Stop the active Conversation Relay session on a call." Body takes only `client_state` and `command_id`. [quoted: STOP]
3. Closing the socket: "Closing the WebSocket terminates the Conversation Relay session." [quoted: GUIDE]

**Does `end` wait for queued speech?** Not stated. "Gracefully" is the only word. [unverified]

**Hanging up after a final sentence, documented paths.**
- TeXML: "The `<Connect>` verb runs in synchronous mode. When the nested `<ConversationRelay>` service stops, Telnyx either continues with the next TeXML instructions in the same response or, when `action` is set on `<Connect>`, sends a request to that callback URL so your application can return the next TeXML document." [quoted: GUIDE] Telnyx's own example speaks the goodbye after the relay: `<Say voice="Telnyx.Ultra.Callie">Conversation Relay has ended. Goodbye.</Say><Hangup />`. [quoted: GUIDE] So the application can return its own final sentence from the `action` callback as `<Say>` then `<Hangup/>`, and TeXML plays verbs in sequence. [inferred]
- TeXML with `events="speaker-events"`: wait for `agentSpeaking` `off` ("true end-of-playout") [quoted: VERB], then send `end`. [inferred]
- Call Control: after the relay ends, `POST /calls/{id}/actions/hangup` (webhook `call.hangup`). [quoted: https://developers.telnyx.com/api-reference/call-commands/hangup-call.md] There is no documented signal that the last sentence finished playing, so the safe order is unknown. [unverified] One documented alternative is to stop the relay and speak the last line with `speak`, which emits `call.speak.ended`. [quoted: https://developers.telnyx.com/api-reference/call-commands/speak-text.md] Mixing the two is my suggestion, not Telnyx's. [inferred]

**Webhooks and callbacks.**
- Call Control: "`call.conversation.ended` - Sent when the Conversation Relay session ends. If the customer WebSocket disconnects, the webhook payload `reason` is `customer_disconnect`." [quoted: START]
- The relay guide's example payload shows only `event_type`, `payload.reason`, `record_type`. [quoted: GUIDE]
- The event's schema is shared with AI Assistants. Payload fields: `assistant_id`, `call_control_id`, `connection_id`, `call_leg_id`, `call_session_id`, `client_state`, `calling_party_type`, `conversation_id`, `duration_sec`, `reason` (string or null; "For Conversation Relay, `customer_disconnect` indicates that the customer WebSocket disconnected."), `messages[]` (`role`, `content`, `timestamp`). The example also has `from`, `to`, `llm_model`, `stt_model`, `tts_model_id`, `tts_provider`, `tts_voice_id`. [quoted: SPEC, `callConversationEnded`] [quoted: EVENTS] Which of these are filled for a relay session, and the other `reason` values (after `end`, after `conversation_relay_stop`, after caller hangup), are not documented. [unverified]
- No relay-specific "started" webhook is documented. `call.conversation.created` is described only for AI assistants. [quoted: EVENTS] [inferred]
- TeXML `<Connect action>`: "The request payload includes a `Reason` field describing why the service ended." The listed reasons (`normal`, `service_error`, `stt_error`, `handoff`, `hangup`) are given "For `<AIAssistant>`". [quoted: CONNECT] The reasons for the relay, and whether `handoffData` is delivered in this request, are not documented. [unverified]
- `<Hangup/>`: "a callback is sent to the webhook URL defined on the connection level with `CallStatus` set to `completed`." [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/hangup.md]

---

## 6. Limits and constraints

- One per call: "Only one AI Assistant or Conversation Relay session can be active on a call at a time." [quoted: START] Error "90067 | Conversation Relay is already in progress | A Conversation Relay session is already active on this call. Stop the current session before starting a new one." Also 90068 "is not in progress", 90069 "start failed", 90070 "stop failed". [quoted: https://developers.telnyx.com/public/llms/fundamentals-full.txt]
- Call must be answered: the command's 422 examples include "90034 | Call not answered yet". [quoted: START] (That list is the generic Call Control error list. [inferred])
- Max text length per `text` frame or per turn: not documented. [unverified] For comparison only, the `speak` command says "There is a 3,000 character limit." [quoted: https://developers.telnyx.com/api-reference/call-commands/speak-text.md]
- Concurrency: nothing relay-specific. Account level: "Pay as you go includes 500 concurrent calls, 100 API requests per second". [quoted: PRICE-AI]
- Regions: nothing relay-specific. Voice API on `api.telnyx.eu`: "Supported. Set the application's AnchorSite® to an EU site." TeXML: "Supported via EU media sites." [quoted: https://developers.telnyx.com/docs/account-setup/regional-endpoints.md] Where STT and TTS run for a relay session is [unverified].
- Codecs: the relay carries text, so none apply to the socket; nothing is said about the call leg's codec. [inferred] `play` audio formats are not listed (example is mp3). [unverified]
- Socket: one per session, no reconnect (section 2). URL may be `ws://` or `wss://` per the schema; the release note requires "A WebSocket server reachable over WSS". [quoted: START] [quoted: RELNOTE]
- Flux is English only (`flux-multi` for 10 languages), which limits partial prompts and eager end-of-turn. [quoted: https://developers.telnyx.com/docs/voice/stt/models.md]
- L1-verified accounts get an abuse notice prepended to "machine-generated speak commands"; the listed endpoints do not include the relay. [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/l1-accounts-restirctions.md] Whether it applies to relay speech is [unverified].
- Keep-alive, idle timeout, maximum session duration, maximum frame size: not documented. [unverified]

---

## 7. Alternatives where Telnyx hosts the assistant

**a. AI Assistant with a custom LLM (`external_llm`).** This is the way to make an external service the per-turn brain inside a Telnyx-hosted assistant.
- "you can also power your AI Assistant with any public OpenAI-compatible chat completions endpoint." "You must have a publicly accessible OpenAI-compatible chat completions endpoint". [quoted: https://developers.telnyx.com/docs/inference/ai-assistants/custom-llm.md]
- Config: `external_llm: { model, base_url, llm_api_key_ref, authentication_method, forward_metadata, extra_headers }`. [quoted: same page]
- "By default, Telnyx does not include your assistant's dynamic variables in requests to a custom LLM endpoint." With `forward_metadata: true`, "Telnyx adds a top-level `extra_metadata` object to the OpenAI-compatible chat completions request body". Example keys: `customer_name`, `account_id`, `telnyx_agent_target`, `telnyx_end_user_target`. [quoted: same page]
- `extra_headers`: "Header values are static strings, and you can set up to 32 headers." [quoted: same page]
- So the receptionist engine would have to present itself as an OpenAI-compatible `/chat/completions` server and answer each request Telnyx sends. [inferred]
- Control lost compared with the relay [inferred, from the pages above]:
  - Telnyx assembles the request (assistant `instructions` as the system message plus its own message history); the engine receives a transcript Telnyx built rather than one caller utterance and its own Session.
  - No call identifier is documented in the request. The documented `extra_metadata` example has phone numbers, not `call_control_id`, so mapping a request to a Call is not documented.
  - Turn-taking, barge-in handling and the decision to call the model belong to Telnyx ("Orchestration: Full agent runtime - turn-taking, interruption handling, tools, knowledge base retrieval." [quoted: PRICE-AI]).
  - Ending and transferring are assistant tools (`hangup`, `transfer`, `webhook`, ... [quoted: https://developers.telnyx.com/api-reference/call-commands/start-ai-assistant.md]), triggered by model tool calls in OpenAI format, not by the engine's own decision outside the model.
  - No barge-in or playback feedback reaches the endpoint; there is no `interrupt` or `tokensPlayed` equivalent on a chat-completions request.
  - Whether streaming is required, and timeouts, are not on the custom LLM page. [unverified]

**b. Anthropic as a Telnyx-managed model.** "`anthropic/claude-haiku-4-5` | Anthropic (native) | Fast, lightweight model — no API key required". [quoted: https://developers.telnyx.com/docs/inference/ai-assistants/no-code-voice-assistant.md] `llm_api_key_ref` "Supports any LLM provider (OpenAI, Anthropic, etc.)." [quoted: https://developers.telnyx.com/api-reference/call-commands/start-ai-assistant.md] "Reasoning (thinking) is always disabled on voice calls, on every model, and cannot be enabled". [quoted: no-code-voice-assistant.md] Here Telnyx owns the LLM call, which is what the requirement rules out, and "never disable thinking" (the project's I7) cannot hold. [inferred]

**c. Dynamic variables webhook.** Start-of-call only for voice: "we will `POST` the following payload at the start of a voice call, and on every turn of an SMS or chat conversation." Event `assistant.initialization`, payload includes `call_control_id` and `assistant_id`; signed; "default 1.5 seconds, up to 10 seconds via the `dynamic_variables_webhook_timeout_ms`". [quoted: https://developers.telnyx.com/docs/inference/ai-assistants/dynamic-variables.md] Not a per-turn hook on calls. [inferred]

**d. Webhook tools.** The assistant's model decides when to call them (`WebhookTool` among the assistant tools [quoted: start-ai-assistant.md]). The external service answers a tool call; it does not write the reply. [inferred]

**e. Delegation, `mode: "client"` (Beta).** "Set `mode: "client"` and Telnyx relays each delegation to your own server over the WebSocket configured in `websocket_settings`". "The answer is text only... `output` is plain text that gets injected as context." "Either way the result is injected back as context, not spoken verbatim by the backend." [quoted: https://developers.telnyx.com/docs/inference/ai-assistants/delegation.md] The Telnyx-side frontend model still words the reply. [inferred]

**f. Conversation event stream (Beta).** "The assistant keeps the brain. This socket observes and injects — it does not replace the model, and it is not in the call path." [quoted: https://developers.telnyx.com/docs/inference/ai-assistants/conversation-event-stream.md]

**g. Lower-level building blocks (application keeps the brain, does more work).**
- Raw media streaming over WebSocket with bidirectional audio (`stream_bidirectional_mode` `rtp` or mp3; codecs `PCMU, PCMA, G722, OPUS, AMR-WB, L16`), with a `clear` message and a signed handshake. The application must run its own STT and TTS. [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming.md] [quoted: SPEC]
- Call Control `transcription_start` (webhook `call.transcription`) plus `speak` (webhooks `call.speak.started`, `call.speak.ended`; "If multiple speak text commands are issued consecutively, the audio files will be placed in a queue awaiting playback."). [quoted: https://developers.telnyx.com/api-reference/call-commands/transcription-start.md] [quoted: https://developers.telnyx.com/api-reference/call-commands/speak-text.md] Text in, text out over HTTP webhooks instead of a socket. Barge-in handling would be the application's job. [inferred]

---

## 8. Pricing as published

**Conversation Relay.**
- "Conversation Relay | $0.05 per minute" (Voice API pricing page, "Optional features"). [quoted: PRICE-VOICE]
- "Call Control Features Conversation Relay - per minute | $0.05 | minute | usage". [quoted: PRICE-ALL]
- "Starting at $0.05 per minute. You bring your own AI engine, so there is no model or platform fee from Telnyx for the reasoning layer." [quoted: PRODUCT]
- Whether STT and TTS are inside the $0.05 is not stated for the relay. The same pricing page says of its table: "Each row is a line on your invoice. Nothing is bundled into another primitive's rate and nothing turns on unless you call it." [quoted: PRICE-VOICE] Read literally, STT minutes, TTS characters and the Voice API fee are billed on top; "Starting at" on the product page points the same way. [inferred] No worked example for a relay call is published. [unverified]
- Rows that would then apply [quoted: PRICE-VOICE]: Voice API "$0.002 per minute + the SIP Trunking fee"; "Deepgram Nova 2 STT | $0.005 per minute", "Deepgram Nova 3 STT | $0.005 per minute", "Deepgram Flux STT | $0.005 per minute", "Telnyx STT | $0.015 per minute", "Google STT | $0.017 per minute", "Azure STT | $0.027 per minute"; "Telnyx TTS | $0.000003 per character", "Telnyx Ultra | $0.000032 per character", "Neural Voices TTS (Amazon Polly) | $0.000024 per character", "ElevenLabs TTS | BYO API key (billed by ElevenLabs)", "Azure Neural HD TTS | BYO API key (billed by Azure)".
- SIP trunking: "from $0.0032 / min" inbound, "from $0.005 / min" outbound (US). US local number "$1.00 / mo". [quoted: PRICE-AI]

**AI Assistants (Voice AI Agents).**
- "$0.05 per minute... Orchestration, speech-to-text, and text-to-speech in one rate. LLM tokens at our own GPU prices, telephony at carrier cost." [quoted: PRICE-AI]
- "The voice engine: orchestration (turn-taking, interruption handling, tools, knowledge base retrieval) plus Telnyx-hosted speech-to-text (including Deepgram models) and Telnyx-hosted text-to-speech (Telnyx Ultra, Natural, NaturalHD, Qwen3TTS, Inworld, Rime, Resemble, Murf)." [quoted: PRICE-AI]
- "LLM usage is billed per token... Managed frontier models from Anthropic and OpenAI are billed at provider list rates on the same Telnyx invoice." [quoted: PRICE-AI]
- "Each call is billed in 60-second increments: the connected duration of each call is rounded up to the next full minute". [quoted: PRICE-AI] (Stated for the voice engine; whether the relay rounds the same way is [unverified].)
- With a custom LLM endpoint, Telnyx's LLM token charge would not apply since the model is not Telnyx's; this is not stated on the pricing page. [inferred]

**Media streaming.** "Media Streaming over WebSockets | $0.0035 per minute". [quoted: PRICE-VOICE]

**Plan limits.** Pay as you go: "500 concurrent calls, 100 API req/s, 50 SMS/s". [quoted: PRICE-AI]

---

## Contradictions and gaps in the docs

Contradictions:

1. **Status wording.** The release note says "now available" with no GA or beta label. A search summary's "general availability" and `stream_bidirectional_mode: text` are not on the page; the spec's enum is `mp3, rtp`. [quoted: RELNOTE] [quoted: SPEC]
2. **`events` exists in TeXML only.** `speaker-events` and `tokens-played` are on the verb page; the Call Control schema has no such property, and the guide does not mention `info` frames at all. [quoted: VERB] [quoted: SPEC]
3. **Eager end-of-turn range.** Relay command: `eager_eot_threshold` 0.3 to 0.7. STT socket page: "(`0.3`–`0.9`)... Must be ≤ `eot_threshold`". [quoted: START] [quoted: https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters/end-of-turn.md]
4. **Flux options vs the schema the relay points at.** The relay says it takes "the same provider-specific options used by the Call Transcription Start command", but `DeepgramFluxConfig` there has only `interim_results`, `language`, `keyterms`; `eot_threshold` and `eager_eot_threshold` are documented only on the relay schema. [quoted: START] [quoted: SPEC]
5. **Language codes.** TeXML examples use `en`, `fr`, `es`; Call Control examples use `en-US` with a per-language entry `es`; the `language` frame example uses `es-ES`; the default is `en`. No page says which forms each engine accepts. [quoted: GUIDE] [quoted: START]
6. **Model naming.** TeXML `speechModel="flux"` / `nova-2`; Call Control `transcription_model: "deepgram/nova-3"`; the SDK example passes `speechModel => 'nova-3'`. [quoted: VERB] [quoted: START]
7. **Engine name casing.** `transcriptionProvider="deepgram"` in TeXML vs `"transcription_engine": "Deepgram"` (enum) in Call Control. [quoted: GUIDE]
8. **Voice provider list.** The `voice` description opens "Currently we support ElevenLabs, Telnyx and AWS voices" and then lists nine providers; `voice_settings` accepts `minimax` and `resemble`, which the `voice` description omits, and has no type for Fish Audio or Humain, which it lists. [quoted: START]
9. **Telnyx voice families.** The verb page's examples use `Telnyx.Natural.abbie` and `Telnyx.NaturalHD.astra`; the current Telnyx TTS model table lists only KokoroTTS, Qwen3TTS, Ultra, Grok, Bayan, Sukhan. The pricing FAQ still names "Natural, NaturalHD". [quoted: VERB] [quoted: https://developers.telnyx.com/docs/voice/tts/providers/telnyx.md] [quoted: PRICE-AI]
10. **Ultra availability.** "**REST only** — Ultra is not available over public WebSocket" on the Ultra page, while the relay guide's examples use `Telnyx.Ultra.Callie`. Probably the warning is about the standalone TTS socket only. [quoted: https://developers.telnyx.com/docs/voice/tts/providers/telnyx/ultra.md] [quoted: GUIDE] [inferred]
11. **Integration secret body.** The in-call TTS guide posts `{"identifier": ..., "value": ...}`; the API reference requires `identifier`, `type`, and `token`. [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/tts.md] [quoted: https://developers.telnyx.com/api-reference/integration-secrets/create-a-secret.md]
12. **ElevenLabs voice string.** `ElevenLabs.<ModelId>.<VoiceId>` (command), `ElevenLabs.Default.cgSgspJ2msm6clMCkdW9` (in-call guide), `elevenlabs.<Model>.<VoiceId>` lower-case (provider page). [quoted: START] [quoted: tts.md] [quoted: elevenlabs.md]
13. **`ws://` vs WSS.** Schema allows `ws://`; guide says "public `wss://`"; release note requires WSS. [quoted: START] [quoted: GUIDE] [quoted: RELNOTE]
14. **Deepgram STT price.** $0.005/min on the Voice API pricing page and live rate sheet; "$0.0074/min" in the summary table at the top of `pricing.md`. [quoted: PRICE-VOICE] [quoted: PRICE-ALL]
15. **Telnyx TTS price.** "$0.000003 per character" (Voice API page) vs "Telnyx | $0.000006/char" (summary table). [quoted: PRICE-VOICE] [quoted: PRICE-ALL]
16. **`custom_parameters` typing.** Described as becoming `assistant.dynamic_variables` (strings only) but typed as free-form, and delivered as `setup.customParameters`. [quoted: START] [quoted: GUIDE]

Gaps (the docs are silent):

- Authentication or signature on the relay WebSocket handshake.
- What happens to queued and in-flight speech on barge-in; no `clear`.
- Whether `end` or `conversation_relay_stop` lets queued speech finish.
- Any end-of-playback or played-text signal when started from Call Control.
- Meaning and precision of `utteranceUntilInterrupt` and `durationUntilInterruptMs`; meaning of `play.interruptible` and `play.preemptible`.
- Ordering between `interrupt`, `prompt`, `info` and the application's `text` frames; whether a new `text` turn can start while the previous is playing.
- How end of turn is decided for non-Flux engines; `eot_timeout_ms` for the relay; no-input or silence timeout.
- Maximum `text` length, frame size, session length, idle timeout, ping/pong.
- `reason` values of `call.conversation.ended` other than `customer_disconnect`; which payload fields are populated for a relay; whether `messages` is filled.
- `Reason` values and `handoffData` delivery in the TeXML `<Connect action>` request for a relay.
- What the call does after the socket drops under Call Control.
- TTS provider credentials (ElevenLabs) and voice settings in the TeXML form.
- Whether $0.05/min includes STT and TTS; billing increment for the relay.
- Supported provider combinations; regions where the relay's STT and TTS run.
- What a "community engine" is and how one is registered (named on the verb page only).
- No code example for the relay in Telnyx's code-examples index.

---

## URLs fetched

Loaded (HTTP 200), all on 2026-11-16:

- https://developers.telnyx.com/llms.txt
- https://developers.telnyx.com/docs/voice/programmable-voice/conversation-relay.md
- https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/conversationrelay.md
- https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/connect.md
- https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/hangup.md
- https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/aiassistant.md
- https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/say.md
- https://developers.telnyx.com/api-reference/call-commands/start-conversation-relay.md
- https://developers.telnyx.com/api-reference/call-commands/stop-conversation-relay.md
- https://developers.telnyx.com/api-reference/call-commands/answer-call.md
- https://developers.telnyx.com/api-reference/call-commands/hangup-call.md
- https://developers.telnyx.com/api-reference/call-commands/speak-text.md
- https://developers.telnyx.com/api-reference/call-commands/transcription-start.md
- https://developers.telnyx.com/api-reference/call-commands/start-ai-assistant.md
- https://developers.telnyx.com/api-reference/call-commands/add-messages-to-ai-assistant.md
- https://developers.telnyx.com/api-reference/callbacks/call-conversation-ended.md (loaded, but the page body has no schema; the schema came from SPEC and EVENTS)
- https://developers.telnyx.com/api-reference/callbacks/texml-call-completed.md (loaded, no schema in body)
- https://developers.telnyx.com/api-reference/integration-secrets/create-a-secret.md
- https://developers.telnyx.com/api-reference/speech-to-text-capabilities/list-supported-stt-providers.md
- https://developers.telnyx.com/data/webhook-events.json
- https://raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json
- https://developers.telnyx.com/public/llms/calling/voice-api.txt and voice-api-full.txt
- https://developers.telnyx.com/public/llms/calling/texml.txt and texml-full.txt
- https://developers.telnyx.com/public/llms/ai/assistants.txt and assistants-full.txt
- https://developers.telnyx.com/public/llms/voice/tts.txt and tts-full.txt
- https://developers.telnyx.com/public/llms/voice/stt.txt and stt-full.txt
- https://developers.telnyx.com/public/llms/voice/overview.txt
- https://developers.telnyx.com/public/llms/fundamentals-full.txt
- https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming.md
- https://developers.telnyx.com/docs/voice/programmable-voice/tts.md
- https://developers.telnyx.com/docs/voice/programmable-voice/speech-to-text.md
- https://developers.telnyx.com/docs/voice/programmable-voice/gather-using-ai.md
- https://developers.telnyx.com/docs/voice/programmable-voice/ai-assistant-start.md
- https://developers.telnyx.com/docs/voice/programmable-voice/receiving-webhooks.md
- https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks.md
- https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-commands-and-resources.md
- https://developers.telnyx.com/docs/voice/programmable-voice/l1-accounts-restirctions.md
- https://developers.telnyx.com/docs/voice/tts/available-voices.md
- https://developers.telnyx.com/docs/voice/tts/in-call-playback.md
- https://developers.telnyx.com/docs/voice/tts/providers/elevenlabs.md
- https://developers.telnyx.com/docs/voice/tts/providers/telnyx.md
- https://developers.telnyx.com/docs/voice/tts/providers/telnyx/ultra.md
- https://developers.telnyx.com/docs/voice/tts/providers/aws.md
- https://developers.telnyx.com/docs/voice/tts/providers/azure.md
- https://developers.telnyx.com/docs/voice/tts/rest-api/pricing.md
- https://developers.telnyx.com/docs/voice/stt/models.md
- https://developers.telnyx.com/docs/voice/stt/in-call-transcription.md
- https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters/end-of-turn.md
- https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters/endpointing.md
- https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters/engines-and-models.md
- https://developers.telnyx.com/docs/voice/stt/websocket-streaming/pricing.md
- https://developers.telnyx.com/docs/inference/ai-assistants/custom-llm.md
- https://developers.telnyx.com/docs/inference/ai-assistants/delegation.md
- https://developers.telnyx.com/docs/inference/ai-assistants/conversation-event-stream.md
- https://developers.telnyx.com/docs/inference/ai-assistants/dynamic-variables.md
- https://developers.telnyx.com/docs/inference/ai-assistants/interruption-settings.md
- https://developers.telnyx.com/docs/inference/ai-assistants/transcription-settings.md
- https://developers.telnyx.com/docs/inference/ai-assistants/async-tools.md
- https://developers.telnyx.com/docs/inference/ai-assistants/workflows.md
- https://developers.telnyx.com/docs/inference/ai-assistants/no-code-voice-assistant.md
- https://developers.telnyx.com/docs/inference/ai-assistants/realtime-conversations.md
- https://developers.telnyx.com/docs/inference/ai-assistants/integrations.md
- https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks.md
- https://developers.telnyx.com/docs/development/api-fundamentals/reliability/rate-limiting.md
- https://developers.telnyx.com/docs/development/llms/code-examples.md
- https://developers.telnyx.com/docs/account-setup/regional-endpoints.md
- https://developers.telnyx.com/compare.md
- https://developers.telnyx.com/pricing.md
- https://telnyx.com/pricing.md
- https://telnyx.com/pricing/voice-api.md
- https://telnyx.com/pricing/voice-ai-agents.md
- https://telnyx.com/pricing/text-to-speech.md
- https://telnyx.com/pricing/speech-to-text.md
- https://telnyx.com/release-notes/conversation-relay-stream-text-websockets (HTML) and the same with `.md`
- https://telnyx.com/release-notes.md (index; lists no other relay entry)
- https://telnyx.com/products/conversation-relay (HTML)
- https://telnyx.com/ai/capabilities.json (no relay content)
- https://api.github.com/repos/team-telnyx/openapi/commits?path=openapi/spec3.json&per_page=1 (spec date only)

Failed to fetch: none.

Not fetched (seen only as search results, third-party, not used as fact): github.com/DialogWright/dialogwright pull requests #34, #36, #45; github.com/mbundgaard/pi-telnyx.

Loaded but read only in part (large; searched for the terms needed): `spec3.json`, `pricing.md`, the `*-full.txt` bundles, `answer-call.md`, `start-ai-assistant.md`, `transcription-start.md`, `workflows.md`, `async-tools.md`, `realtime-conversations.md`, `integrations.md`.
