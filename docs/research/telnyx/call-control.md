# Telnyx Voice API (Call Control) and media streaming: research notes

Date fetched: 2026-11-16. All pages were fetched as raw Markdown / JSON / HTML with `curl` (the docs site serves a `.md` twin of every page), so quotes are verbatim from the source text, not from a summariser. Scope: Voice API / Call Control (JSON webhooks + REST commands) and media streaming over WebSocket for an inbound call handled by a custom Node 24 / TypeScript server. TeXML and Conversation Relay are covered by other researchers and are only named here.

Tag legend:
- `[quoted: URL]` the statement is supported by the verbatim quote that follows, from that URL.
- `[schema: URL]` taken from the OpenAPI schema (field name, enum, default) at that URL; the quoted description is verbatim.
- `[inferred]` my reading of the quoted material; not stated by Telnyx.
- `[unverified]` not found in any Telnyx page I fetched. Where I add something from memory it is labelled "from memory, unverified".

Short names for the most used sources:
- OAS = https://developers.telnyx.com/openapi/source/external/call-control/call-control.json (the OpenAPI source the API reference pages embed; 73 paths, 62 webhooks, 309 schemas)
- WH = https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks.md
- WHF = https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks.md
- RW = https://developers.telnyx.com/docs/voice/programmable-voice/receiving-webhooks.md
- MS = https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming.md
- GS = https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-fundamentals.md
- PRICE = https://telnyx.com/pricing/voice-api (https://telnyx.com/pricing/call-control redirects here)

---

## 1. Inbound call lifecycle with a Voice API (Call Control) application

### 1.1 Setup

1. Account, API key (Bearer), webhook URL, phone number, then a "Voice API Application". [quoted: GS] "A Voice API Application defines how Telnyx handles calls to and from your numbers."
2. Application fields in the portal [quoted: GS]:
   - "**Webhook URL**: Where Telnyx sends call events, must include a scheme such as 'https'."
   - "**Webhook failover URL**: Backup URL used if primary webhook URL fails after two consecutive delivery attempts."
   - "**Webhook API version**: Determines which webhook format will be used, API v1 or v2 (v2 recommended)."
   - "**Anchor site**: Routes media through the site with the lowest round-trip time to your connection."
   - "**Enable hang-up on timeout**: Hang up calls if no response to webhook within specified time."
   - "**Custom webhook timeout**: Time in seconds to wait for webhook response before timing out."
   - Inbound: "**Inbound channel limit**: Set the maximum number of simultaneous inbound calls allowed for this application." and "**Codecs**: Select which audio and video formats your application will support for optimal call quality."
3. The same thing over REST is `POST /v2/call_control_applications`. [schema: OAS `CreateCallControlApplicationRequest`] required: `application_name`, `webhook_event_url`. Other fields: `webhook_event_failover_url`, `webhook_api_version` (enum `"1"`, `"2"`, **default `"1"`**: "Determines which webhook format will be used, Telnyx API v1 or v2."), `webhook_timeout_secs` (0 to 30, default null: "Specifies how many seconds to wait before timing out a webhook."), `anchorsite_override` (default `"Latency"`), `first_command_timeout` (default false: "Specifies whether calls to phone numbers associated with this connection should hangup after timing out."), `first_command_timeout_secs` (default 30), `inbound.channel_limit`, `inbound.sip_subdomain`, `outbound.outbound_voice_profile_id`, `dtmf_type`, `call_cost_in_webhooks`.
4. `connection_id` is the application id. [quoted: GS] "`connection_id`: Your connection\_id (which is the Application ID) from your Voice API Application details page."
5. Number assignment. [quoted: GS] "select which numbers to associate with your application for handling inbound and outbound calls." and [quoted: https://developers.telnyx.com/docs/numbers/phone-numbers/buy-phone-number.md] "**For Voice applications**: Assign it to a Voice API Application or SIP Connection."
6. Outbound voice profile. Needed for dialing out, which includes `transfer` and `dial` to a human. [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/get-started.md] "A Voice API application (also called a Call Control connection) with a webhook URL, and an Outbound Voice Profile attached to it." and "**Outbound Voice Profile**: This component is key to configuring outbound calls, including setting up billing and controlling traffic destinations." [inferred] A purely inbound receptionist that never transfers does not need one; the moment it transfers to a human it does.

### 1.2 Events in order

[quoted: GS] "1. **Call Initiated** ... 2. **Webhook Sent**: Telnyx sends a `call.initiated` webhook to your URL. 3. **Call Progress**: Telnyx sends additional webhooks as the call progresses (`call.answered`, `call.hangup`, etc.). 4. **Your Response**: When the call is answered, you can use Voice API commands to control it (e.g., `speak`, enable `transcription`, start `recording`). 5. **Call End**: Final webhook (`call.hangup`) sent when the call completes."

For an inbound call [inferred from the pieces below]:

| Step | What happens | Source |
| - | - | - |
| 1 | `call.initiated` arrives with `direction: "incoming"`, `state: "parked"` | [quoted: RW] example payload `"direction": "incoming", "state": "parked"` |
| 2 | You send `answer` (or `reject`) | [quoted: OAS answer] "Answer an incoming call. You must issue this command before executing subsequent commands on an incoming call." |
| 3 | `call.answered` arrives | [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/sending-commands.md] table row "Answer call ... `call.answered`" |
| 4 | Your commands and their events (`call.speak.started/ended`, `call.transcription`, `streaming.started/stopped/failed`, `call.dtmf.received`, ...) | sections 3 and 4 |
| 5 | `call.hangup` (caller hung up, or after your `hangup`), then `call.recording.saved` if recording | [quoted: OAS hangup] "**Expected Webhooks:** - `call.hangup` - `call.recording.saved`" |

Order is a tendency, not a guarantee. [quoted: sending-commands.md] "When multiple webhooks are listed, you can expect to often, though not always, receive webhooks in the order provided."

The `answer` HTTP response is not the answer. [quoted: OAS answer] "The HTTP success response can arrive before the call is answered; use the `call.answered` webhook to track the answer."

### 1.3 Envelope and identifying fields

Envelope [quoted: WH]:

```json
{
  "data": {
    "record_type": "event",
    "event_type": "call.initiated",
    "id": "0ccc7b54-4df3-4bca-a65a-3da1ecc777f0",
    "occurred_at": "2018-02-02T22:25:27.521992Z",
    "payload": {
      "call_control_id": "d14dbcee-880b-11eb-8204-02420a0f7568",
      "connection_id": "7267xxxxxxxxxxxxxx",
      "call_leg_id": "d14dbcee-880b-11eb-8204-02420a0f7568",
      "call_session_id": "428c31b6-abf3-3bc1-b7f4-5013ef9657c1",
      "client_state": "aGF2ZSBhIG5pY2UgZGF5ID1d",
      "from": "+12025550133",
      "to": "+12025550131",
      "direction": "incoming",
      "state": "parked"
    }
  },
  "meta": { "attempt": 1, "delivered_to": "https://example.com/webhooks" }
}
```

Field meanings [quoted: WH "Common fields" table]:

| Field | Location | Telnyx's description |
| - | - | - |
| `id` | `data` | "Unique identifier for this webhook event" |
| `occurred_at` | `data` | "ISO 8601 timestamp of when the event occurred" |
| `call_control_id` | `data.payload` | "ID used to issue call control commands for this call leg" |
| `call_leg_id` | `data.payload` | "Unique ID for this call leg — use to correlate webhooks" |
| `call_session_id` | `data.payload` | "Shared ID across related call legs (e.g., both sides of a transfer)" |
| `connection_id` | `data.payload` | "Voice API connection used for the call" |
| `client_state` | `data.payload` | "Base64-encoded state passed through from a previous command" |
| `from` / `to` | `data.payload` | "Calling party number or SIP URI" / "Called party number or SIP URI" |
| `attempt` | `meta` | "Delivery attempt number (increments on retries)" |
| `delivered_to` | `meta` | "URL the webhook was sent to" |

Extra `call.initiated` payload fields [schema: OAS `CallInitiated`]: `connection_codecs`, `offered_codecs`, `custom_headers`, `sip_headers` ("User-to-User and Diversion headers from sip invite."), `shaken_stir_attestation`, `shaken_stir_validated`, `caller_id_name`, `call_screening_result` (example `spam_likely`), `direction` (`incoming` | `outgoing`), `state` (`parked` | `bridging`), `start_time`, `tags`.

`call.hangup` payload adds [schema: OAS `CallHangup`]: `hangup_cause` enum `call_rejected`, `normal_clearing`, `originator_cancel`, `timeout`, `time_limit`, `user_busy`, `not_found`, `no_answer`, `unspecified`; `hangup_source` enum `caller`, `callee`, `unknown`; `sip_hangup_cause` ("If the SIP response is unavailable (in inbound calls for example) this is set to `unspecified`."); `call_quality_stats` (nullable).

`call_control_id` is also a routing token. [quoted: sending-commands.md] "It also helps Telnyx route the call to the location where the call is being managed, resulting in the lowest possible latency for Call Control interactions." Its format differs across examples (`v3:...`, `v2:...`, bare UUID); treat it as opaque. [inferred]

`client_state` on every command: [schema: OAS] "Use this field to add state to every subsequent webhook. It must be a valid Base-64 encoded string." There is also a dedicated command `POST /v2/calls/{call_control_id}/actions/client_state_update`.

### 1.4 Answer, hangup, reject

- `POST https://api.telnyx.com/v2/calls/{call_control_id}/actions/answer`, `Authorization: Bearer YOUR_API_KEY`, JSON body. [quoted: sending-commands.md] the curl example. Notable body fields [schema: OAS `AnswerRequest`]: `client_state`, `command_id`, `webhook_url` ("Use this field to override the URL for which Telnyx will send subsequent webhooks to for this call."), `webhook_url_method`, `webhook_urls`, `webhook_retries_policies`, `stream_url` and the other `stream_*` fields (section 4), `transcription` + `transcription_config`, `record` (`record-from-answer`), `send_silence_when_idle`, `assistant`, `conversation_relay_config`.
- `POST /v2/calls/{call_control_id}/actions/hangup`. Body optional fields: `client_state`, `command_id`, `custom_headers`, `reason`. [quoted: OAS hangup] "Hang up the call."
- `POST /v2/calls/{call_control_id}/actions/reject`. [quoted: OAS reject] "Reject an incoming call." Expected webhook `call.hangup`.
- Command responses [quoted: sending-commands.md]: 200 "The request succeeded."; 403; 404; 422 "The request has invalid parameters or the call is no longer active." Success body is `{"data": {"result": "ok"}}` [schema: OAS `CallControlCommandResult`].
- Maximum call length: [schema: OAS `time_limit_secs`] "The default time limit is 14400 seconds or 4 hours and this is also the maximum allowed call length." (documented on `transfer`/`dial` legs.)

---

## 2. Webhook delivery contract

### 2.1 Signature

- Headers. [quoted: WH] "`Telnyx-Signature-Ed25519` | ED25519 signature for verification" and "`Telnyx-Timestamp` | Unix timestamp when the webhook was generated". Also `User-Agent: telnyx-webhooks`, `Content-Type: application/json`.
- What is signed. [quoted: https://developers.telnyx.com/docs/development/migration/call-control-migration-guide.md] "The signature for the payload is calculated by building a string that is the combination of the timestamp of when the request was initiated, the pipe `|` character and the JSON payload. The signature is then `Base64` encoded." The current fundamentals page does not restate this; it only says to use the SDK helper. The SDK source confirms it: [quoted: https://raw.githubusercontent.com/team-telnyx/telnyx-node/master/src/lib/webhooks.ts] "// Create the exact signed payload: timestamp|unmodified payload" and "``const signedPayload = encoder.encode(`${timestampHeader}|${payload}`);``".
- Key type and location. [quoted: WHF] "Products that document Telnyx Ed25519 signing use the account's key pair. The public key is available in [Mission Control Portal](https://portal.telnyx.com/#/api-keys/public-key)." The key is a Base64 string of 32 raw bytes: [quoted: SDK webhooks.ts] "Invalid public key: expected 32 bytes, got ..." and "// Telnyx provides keys in base64 format". Signature is 64 bytes after Base64 decoding (same file).
- Raw body. [quoted: WHF] "Verification requires the exact body bytes received by the server. Do not parse and reserialize JSON before verification."
- Timestamp tolerance. The docs give no number: [quoted: WHF] "reject signatures outside the application's replay window." The official Node SDK hard-codes five minutes: [quoted: SDK webhooks.ts] "// Allow 5 minutes tolerance" / "if (Math.abs(currentTime - webhookTime) > 300)". [inferred] 300 seconds is the de facto recommended tolerance.
- Webhook API version matters: v1 is a different scheme. [quoted: call-control-migration-guide.md] "While API v1 uses an HMAC with the SHA256 hash function to sign webhooks, API v2 uses the EdDSA digital signature scheme with a public key." and "API v2 webhook structures are not enabled by default."

### 2.2 Acknowledgement, retries, timeouts, failover

- Success status. [quoted: WH "Response codes"] "**2xx** | Success | Webhook acknowledged"; "**3xx** | Redirect | Followed (up to 3 redirects)"; "**408, 429** | Timeout / Rate limited | Retried"; "**Other 4xx** | Client error | Not retried"; "**5xx** | Server error | Retried". But the OpenAPI webhook definitions say 200 specifically: [quoted: OAS webhook `callInitiated` responses] "The server must return an HTTP 200, otherwise we will reattempt delivery at the failover webhook URL." And the fundamentals page: [quoted: WHF] "Many products accept any `2xx`. Some products require `200`. Use `200` when the product documentation does not specify another successful status." [inferred] Always answer exactly 200.
- Speed. [quoted: WH] "**Return 2xx immediately** — acknowledge receipt within a few seconds, then process asynchronously." [quoted: WHF] "Avoid database transactions, external API calls, media downloads, and other long-running work before acknowledgment."
- Timeout. Configurable per application: [schema: OAS] `webhook_timeout_secs` "Seconds to wait before timing out (0–30, default: null)" [quoted: WH]. The value used when it is null is [unverified].
- Retry schedule. Not published as numbers for Voice. [quoted: RW] "retries webhook delivery if your application does not respond within a certain time threshold." [quoted: WHF] "Product-specific policies determine retry timing, timeout, and failover destinations. Do not implement one assumed schedule for every Telnyx webhook." The only concrete numbers are per-command overrides: [schema: OAS `webhook_retries_policies` on answer/dial/transfer] "A map of event types to retry policies. Each retry policy contains an array of `retries_ms` specifying the delays between retry attempts in milliseconds. Maximum 5 retries, total delay cannot exceed 60 seconds."
- Failover URL. [quoted: RW] "If that URL does not resolve, or your application returns a non 200 OK response, the webhook will be delivered to the failover URL, if one has been specified." [quoted: GS] "Backup URL used if primary webhook URL fails after two consecutive delivery attempts."
- Per-command routing. [quoted: WH] "**Custom webhook config** — per-command overrides. Pass `webhook_url` and `webhook_url_method` in any call control command to route that command's webhooks to a different endpoint."
- Inspection. [quoted: WH] "Use the [Webhook Deliveries API] ... to inspect delivery history for your account." (`GET /v2/webhook_deliveries`).

### 2.3 Ordering, duplicates, de-duplication key

- [quoted: RW] "In order to minimize webhook delivery time, Telnyx: does not enforce the order in which webhooks are delivered; retries webhook delivery if your application does not respond within a certain time threshold. As a result, you may encounter: out-of-order webhooks; simultaneous (or near simultaneous) webhooks; duplicate webhooks".
- [quoted: WHF] "Do not depend on single delivery or delivery order. Events can be concurrent, duplicated, delayed, or delivered out of order. Reconcile state using `occurred_at` and product resource identifiers where available."
- De-dup key. [quoted: WH] "**Implement idempotency** — webhooks may be delivered more than once. Use the event `id` to deduplicate." [quoted: WHF] "Use the event `id` as a deduplication key when supplied." So the key is `data.id`. Whether a retried delivery keeps the same `data.id` is implied, not stated outright. [inferred]

### 2.4 `command_id` idempotency

- [quoted: RW] "Duplicate webhooks may cause your application to issue duplicate commands. You can instruct Telnyx to ignore duplicate commands by sending a `command_id` parameter as part of your commands. Commands with duplicate `command_id`s within 60 seconds will be ignored."
- [quoted: WH] "Commands with duplicate IDs within 60 seconds are ignored."
- Scope. [schema: OAS, every command] "Use this field to avoid duplicate commands. Telnyx will ignore any command with the same `command_id` for the same `call_control_id`." (no window mentioned in the reference.)
- Format. [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/command-retries.md] "The `command_id` must be unique for each command. We suggest using UUIDv4."
- Retrying commands. [quoted: same page] "Retry on 5XX Errors: If your application receives a 500 error, immediately retry the command." and "Retry on Latency >500ms: If your application fails to receive a HTTP response from Telnyx within 500ms, send an identical command." [inferred] "identical" means same `command_id`, which is what makes the retry safe.
- What an ignored duplicate returns (200 or an error) is [unverified].

---

## 3. In-call speech without raw audio

### 3.1 `transcription_start`

`POST /v2/calls/{call_control_id}/actions/transcription_start`. [quoted: OAS] "Start real-time transcription. Transcription will stop on call hang-up, or can be initiated via the Transcription stop command." Expected webhook: `call.transcription`. It can also be switched on by `answer`: [schema: OAS `AnswerRequest.transcription`] "Enable standalone call transcription upon call answer. The default value is false. Configure this feature with `transcription_config`."

Request [schema: OAS `TranscriptionStartRequest`]: `transcription_engine` (default `Google`; enum `Google`, `Telnyx`, `Deepgram`, `Azure`, `xAI`, `AssemblyAI`, `Speechmatics`, `Soniox`, `Parakeet`, `Humain`, `Reson8`, `Cohere`, legacy `A` = Google, `B` = Telnyx), `transcription_engine_config` (per engine), `transcription_tracks` (default `inbound`: "Use `inbound` for the leg that requested the transcription, `outbound` for the other leg, and `both` for both legs of the call."), `client_state`, `command_id`.

Engines [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/speech-to-text.md]:
- "Google (default) - Google speech-to-text engine that offers additional features like interim results."
- "Telnyx - In-house Telnyx speech-to-text engine with significantly better transcription accuracy and lower latency."
- "Deepgram - Deepgram speech-to-text engine with 3 models (nova-2, nova-3 and flux) that can be set using `transcription_model` setting."
- "Azure - Azure speech-to-text engine with a strong support for multiple languages and accents."
- "xAI - xAI Grok STT engine with the `xai/grok-stt` model."
- "AssemblyAI - AssemblyAI Universal-3.6 Pro engine with the `assemblyai/universal-3-6-pro` model ID."
- "Speechmatics ... `speechmatics/standard` ... or `speechmatics/linden-1` (preview ...)"
- "Soniox - Soniox real-time engine with the `soniox/stt-rt-v4` or `soniox/stt-rt-v6` model. Automatic language detection with interim results and endpointing support."
- "Parakeet - Self-hosted NVIDIA Parakeet engine ... Final transcripts only."
- "Cohere ... `cohere/ar-stt` ... Arabic and English transcription only"; "Reson8 ... `reson8/turns` ... transcripts are delivered per turn of speech."; "Humain ... `humain/realtime`".

Models and options per engine [schema: OAS]:
- Google: `language` (default `en`, long enum), `interim_results` (default false: "Whether to send also interim results. If set to false, only final results will be sent."), `model` enum `latest_long`, `latest_short`, `command_and_search`, `phone_call`, `video`, `default`, `medical_conversation`, `medical_dictation`, `use_enhanced`, `hints`, `speech_context`, `profanity_filter`, diarization fields.
- Telnyx: `language` (default `en`), `transcription_model` enum `openai/whisper-tiny` (default), `openai/whisper-large-v3-turbo`. No `interim_results` field in the schema.
- Deepgram: `transcription_model` one of `deepgram/nova-2`, `deepgram/nova-2-medical`, `deepgram/nova-2-phonecall`, `deepgram/nova-3`, `deepgram/nova-3-medical`, `deepgram/flux`, `deepgram/flux-multi`; `interim_results`; `utterance_end_ms` (default 1000, 0 to 5000: "Number of milliseconds of silence to consider an utterance ended."); `smart_format` (default true); `keyterms` (nova-3, flux), `hints` / `keywords_boosting` (nova-2). Flux: "a conversational speech recognition model with built-in end-of-turn detection."
- Azure: requires `region` (enum `australiaeast`, `centralindia`, `eastus`, `northcentralus`, `westeurope`, `westus2`), optional `api_key_ref`.
- AssemblyAI: `transcription_model` (default `assemblyai/universal-3-5-pro`, an alias of 3.6 Pro), `interim_results`.

`call.transcription` payload [quoted: speech-to-text.md]:

```json
"payload": {
  "call_control_id": "v2:7subYr8fLrXmaAXm8egeAMpoSJ72J3SGPUuome81-hQuaKRf9b7hKA",
  "call_leg_id": "5ca81340-5beb-11eb-ae45-02420a0f8b69",
  "call_session_id": "5ca81eee-5beb-11eb-ba6c-02420a0f8b69",
  "client_state": null,
  "connection_id": "1240401930086254526",
  "transcription_data": {
    "confidence": 0.977219,
    "is_final": true,
    "transcript": "hello this is a test speech"
  }
}
```

[schema: OAS `Transcription...transcription_data`] `is_final`: "When false, it means that this is an interim result."; `confidence` number or null; `transcription_track` enum `inbound` | `outbound`: "This is only available when `transcription_engine` is set to `B`." No end-of-turn / utterance-end field is in the webhook schema, even for Deepgram Flux. [inferred] Turn detection in this mode is "an `is_final: true` webhook arrived"; anything finer needs the standalone STT WebSocket (section 5) or Conversation Relay.

[inferred] Transcripts arrive as ordinary webhooks, so they inherit the delivery contract of section 2: unordered, possibly duplicated, signed, with webhook latency on top of STT latency.

### 3.2 `speak`

`POST /v2/calls/{call_control_id}/actions/speak`. [quoted: OAS] "Convert text to speech and play it back on the call. If multiple speak text commands are issued consecutively, the audio files will be placed in a queue awaiting playback." Expected webhooks: `call.speak.started`, `call.speak.ended`.

Request [schema: OAS `SpeakRequest`], required `payload` and `voice`:
- `payload`: "The text or SSML to be converted into speech. There is a 3,000 character limit."
- `payload_type`: `text` (default) | `ssml`.
- `service_level`: `basic` | `premium` (default `premium`): "When using `basic`, only the `en-US` language and payload type `text` are allowed."
- `stop`: "Specify `current` to stop the current audio being played, and to play the next file in the queue. Specify `all` to stop the current audio file being played and to also clear all audio files from the queue."
- `voice`: "Define voices using the format `<Provider>.<Model>.<VoiceId>`. Specifying only the provider will give default values for voice_id and model_id."
- `voice_settings` (provider-specific; discriminated by `type`: `elevenlabs`, `telnyx`, `aws`, `minimax`, `azure`, `resemble`, `inworld`, `xai`, `soniox`), `language`, `loop`, `target_legs` (default `self`), `client_state`, `command_id`.

Providers and voice string formats [quoted: OAS `SpeakRequest.voice` description]:
- "**AWS:** Use `AWS.Polly.<VoiceId>` (e.g., `AWS.Polly.Joanna`). For neural voices ... append `-Neural`".
- "**Azure:** Use `Azure.<VoiceId>` (e.g., `Azure.en-CA-ClaraNeural` ...)".
- "**ElevenLabs:** Use `ElevenLabs.<ModelId>.<VoiceId>` ... To use ElevenLabs, you must provide your ElevenLabs API key as an integration identifier secret in `\"voice_settings\": {\"api_key_ref\": \"<secret_identifier>\"}`."
- "**Telnyx:** Use `Telnyx.<model_id>.<voice_id>` (e.g., `Telnyx.KokoroTTS.af`)." Models named in the docs: KokoroTTS, Ultra, Qwen3TTS, Bayan, Sukhan.
- "**Minimax:** Use `Minimax.<ModelId>.<VoiceId>`"; "**Resemble:** Use `Resemble.<ModelId>.<VoiceId>`"; "**Inworld:** Use `Inworld.<ModelId>.<VoiceId>`"; "**Fish Audio:** Use `FishAudio.<ModelId>.<VoiceId>`"; "**Soniox:** Use `Soniox.<ModelId>.<VoiceId>` ... SSML is not supported."; "**xAI:** Use `xAI.<VoiceId>`"; "**Humain:** Use `Humain.<VoiceId>`".
- ElevenLabs latency warning. [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/tts.md] "Users get many voice options with ElevenLabs; however, response latency may exceed what you'd see from AWS Polly or Azure AI Speech." and "only a premium ElevenLabs can be used for the integration. The freemium account is not supported".
- Voice catalogue: `GET https://api.telnyx.com/v2/text-to-speech/voices` [quoted: https://developers.telnyx.com/docs/voice/tts/available-voices.md].

Events. `call.speak.started` payload: the five ids plus `client_state`. `call.speak.ended` payload adds `status` enum `completed`, `call_hangup`, `cancelled_amd` ("Reflects how the command ended.") [schema: OAS `CallSpeakEnded`]. There is no status value that says "stopped by `playback_stop`"; what `status` reads after an interruption is [unverified].

L1 accounts get a spoken prefix. [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/l1-accounts-restirctions.md] "All machine-generated speak commands are pre-pended with \"This is an automated call generated on the Telnyx platform, please report any abuse to fraud@telnyx.com\"." (lists `/actions/speak`, `gather_using_speak`, `playback_start`, `transfer`, `/v2/calls`).

### 3.3 `gather_using_speak`

[quoted: OAS] "Convert text to speech and play it on the call until the required DTMF signals are gathered to build interactive menus. You can pass a list of valid digits along with an 'invalid_payload', which will be played back at the beginning of each prompt. Speech will be interrupted when a DTMF signal is received. The `Answer` command must be issued before the `gather_using_speak` command." Expected webhooks: `call.dtmf.received` (many), `call.gather.ended`. Fields: `payload` (3,000 character limit), `invalid_payload`, `voice`, `minimum_digits`, `maximum_digits`, `maximum_tries`, `timeout_millis`, `terminating_digit`, `valid_digits`, `inter_digit_timeout_millis`. [inferred] It is a DTMF (keypad) collector with a spoken prompt. It does not collect speech, so it is not a way to get the Caller's words.

### 3.4 `gather_using_ai`

[quoted: OAS] "Gather parameters defined in the request payload using a voice assistant. You can pass parameters described as a JSON Schema object and the voice assistant will attempt to gather these informations." [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/gather-using-ai.md] "By leveraging AI, this feature can gather details such as names, addresses, or other relevant information based on a list you provided. The collected data is then sent back in a structured format." and "The `required` section specifies when the `gather` process should end. A webhook will be sent when all values from this list are gathered." Fields: `parameters` (required, JSON Schema), `greeting` (3,000 character limit), `voice`, `voice_settings`, `transcription`, `language`, `message_history`, `send_partial_results`, `send_message_history_updates`, `user_response_timeout_ms` (default 10000), `gather_ended_speech`, `interruption_settings`, `assistant`. Events: `call.conversation.created`, `call.ai_gather.ended` (`result` object, `status` `valid` | `invalid`, `message_history`), `call.conversation.ended`, optional `call.ai_gather.partial_results` and `call.ai_gather.message_history_updated`. [inferred] Telnyx's own LLM runs the dialogue here; it is a slot-filling helper, not a way to plug in an external engine.

### 3.5 `ai_assistant_start` (and `answer` with `assistant`)

The command exists: `POST /v2/calls/{call_control_id}/actions/ai_assistant_start`. [quoted: OAS] "Start an AI assistant on the call." Expected webhooks: `call.conversation.created`, `call.conversation.ended`, `call.conversation_insights.generated`. [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/ai-assistant-start.md] "Use `answer` with `assistant.id` when an AI assistant should handle an inbound call from pickup. ... Use `ai_assistant_start` to attach an assistant to a call that is already answered, such as after an IVR or human interaction." and "This is different from Gather using AI, which is purpose-built for collecting structured data. `ai_assistant_start` is for open-ended, conversational AI experiences." Related commands: `ai_assistant_stop`, "Add messages to AI Assistant", "Join AI Assistant Conversation". The assistant is a Telnyx-hosted agent (its own LLM, STT, TTS, tools); the schema does have `external_llm` ("External LLM configuration for bringing your own LLM endpoint.") and `llm_api_key_ref`. Important operational note: [quoted: same guide] "the call leg stays connected and continues to be billed until you hang it up with the Hangup command, the far end hangs up, or the call reaches the platform's maximum call duration." [inferred] This route hands the conversation to Telnyx's agent runtime, so it does not fit an engine in which code, not the model, decides transitions; `external_llm` is the nearest fit and belongs to the text-relay researcher's scope.

### 3.6 Stopping playback

`POST /v2/calls/{call_control_id}/actions/playback_stop`. [quoted: OAS] "Stop audio being played on the call." Expected webhooks: "`call.playback.ended` or `call.speak.ended`". Fields [schema: OAS `PlaybackStopRequest`]: `stop` (default `all`): "Use `current` to stop the current audio being played. Use `all` to stop the current audio file being played and clear all audio files from the queue."; `overlay` (default false). Alternatively pass `stop` on the next `speak` (3.2). [inferred] Barge-in in this mode is: an interim `call.transcription` webhook arrives, you send `playback_stop`. Two webhook/REST round trips sit in that loop; Telnyx publishes no latency figure for it.

---

## 4. Media streaming over WebSocket

### 4.1 Starting a stream

Three ways [quoted: MS]: on `dial` (`POST /v2/calls`), on `answer`, and "It can be requested using answer and streaming\_start commands in the same way." `POST /v2/calls/{call_control_id}/actions/streaming_start`: [quoted: OAS] "Start streaming the media from a call to a specific WebSocket address or Dialogflow connection in near-realtime. Audio will be delivered as base64-encoded RTP payload (raw audio), wrapped in JSON payloads." Stop with `streaming_stop` (expected webhook `streaming.stopped`).

Parameters [schema: OAS `StartStreamingRequest`]:

| Field | Values / default | Telnyx's description |
| - | - | - |
| `stream_url` | `wss://...` | "The destination WebSocket address where the stream is going to be delivered." |
| `stream_track` | `inbound_track` (default), `outbound_track`, `both_tracks` | "Specifies which track should be streamed." |
| `stream_codec` | `PCMU`, `PCMA`, `G722`, `OPUS`, `AMR-WB`, `L16`, `default` (default) | "Specifies the codec to be used for the streamed audio. When set to 'default' or when transcoding is not possible, the codec from the call will be used." |
| `stream_bidirectional_mode` | `mp3` (default), `rtp` | "Configures method of bidirectional streaming (mp3, rtp)." |
| `stream_bidirectional_codec` | `PCMU` (default), `PCMA`, `G722`, `OPUS`, `AMR-WB`, `L16` | "Indicates codec for bidirectional streaming RTP payloads. Used only with stream_bidirectional_mode=rtp. Case sensitive." |
| `stream_bidirectional_target_legs` | `both`, `self`, `opposite` (default) | "Specifies which call legs should receive the bidirectional stream audio." |
| `stream_bidirectional_sampling_rate` | 8000 (default), 16000, 22050, 24000, 48000 | "Audio sampling rate." |
| `custom_parameters` | array of `{name, value}` | "Custom parameters to be sent as part of the WebSocket connection." |
| `stream_auth_token` | string, max 4000 | "An authentication token to be sent as part of the WebSocket connection. Maximum length is 4000 characters." |
| `client_state`, `command_id` | | as for every command |

`AnswerRequest` carries `stream_url`, `stream_track`, `stream_codec`, `stream_bidirectional_mode`, `stream_bidirectional_codec`, `stream_bidirectional_target_legs` but **not** `stream_bidirectional_sampling_rate`, `stream_auth_token` or `custom_parameters` [schema: OAS, checked]. The dial request (`CallRequest`) has `stream_bidirectional_sampling_rate` and `stream_auth_token` (but not `custom_parameters`) plus `stream_establish_before_call_originate`. [inferred] For an inbound call that needs a non-default sampling rate or the auth token, answer first and then send `streaming_start`.

Unidirectional vs bidirectional: there is no separate flag. [inferred] A stream is always able to receive `media` from you; with the default `stream_bidirectional_mode: mp3` what you send must be Base64 MP3, and with `rtp` it must be Base64 audio in `stream_bidirectional_codec`. [quoted: MS] "The RTP stream can be sent to the call using websocket. The functionality can be enabled by setting `stream_bidirectional_mode` to `rtp`."

Codecs [quoted: MS] "There are the following codecs supported by bidirectional streaming: PCMU, 8 kHz (default); PCMA, 8 kHz; G722, 8 kHz; OPUS, 8 kHz, 16 kHz; AMR-WB, 8 kHz, 16 kHz; L16, 16 kHz". "When the audio is sent using a different encoding than on the call, it will be transcoded, which may cause a degradation in quality." "The L16 codec provides improved support for AI voice agent integrations by offering reduced latency and eliminating transcoding overhead when interfacing with many AI platforms that natively support linear PCM audio."

Limits [quoted: MS]: "Currently only one streaming/fork operation is supported per call." "The number of bidirectional RTP streams per call is limited to 1." "Provided chunks of audio can be in a size of 20 milliseconds to 30 seconds." MP3 mode: "Media payloads can only be submitted once per second." and "Media must be base64 encoded mp3."

Webhooks around the stream: `streaming.started` (payload `call_control_id`, `client_state`, `stream_url`), `streaming.stopped` (same), `streaming.failed` (`failure_reason` example `connection_failed`, `stream_id`, `stream_params`, `stream_type` `websocket` | `dialogflow`) [schema: OAS]. Note these event types have no `call.` prefix.

### 4.2 Authentication on the socket

Telnyx is the WebSocket client; it connects to your `stream_url`. [quoted: MS] "Telnyx signs every media stream WebSocket connection, so you can confirm that a connection to your `stream_url` comes from Telnyx. The signature uses your account's Ed25519 key pair, the same one Telnyx uses to sign webhooks. Each connection request includes two headers: `telnyx-signature-ed25519`: the Base64-encoded Ed25519 signature. `telnyx-timestamp`: the Unix time, in seconds, when the request was signed. The signature covers the string `{telnyx-timestamp}|{stream_url}`, where `stream_url` is the exact URL you set when starting the stream, including any query string."

[inferred] Because the signed string is only timestamp + URL, put a per-call unguessable value in the `stream_url` query string (it is covered by the signature) and enforce a short timestamp tolerance yourself; no tolerance is recommended in the docs. `stream_auth_token` and `custom_parameters` exist in the schema, but where they appear (HTTP header, query string, or the `start` frame) is not documented anywhere I fetched. [unverified]

### 4.3 Messages Telnyx sends (all JSON text frames) [quoted: MS]

```json
{ "event": "connected", "version": "1.0.0" }
```

```json
{ "event": "start", "sequence_number": "1",
  "start": {
    "user_id": "3E6F995F-85F7-4705-9741-53B116D28237",
    "call_control_id": "v2:T02llQxIyaRkhfRKxgAP8nY511EhFLizdvdUKJiSw8d6A9BborherQ",
    "call_session_id": "ff55a038-6f5d-11ef-9692-02420aeffb1f",
    "from": "+13122010094", "to": "+13122123456",
    "tags": ["TAG1", "TAG2"],
    "client_state": "aGF2ZSBhIG5pY2UgZGF5ID1d",
    "media_format": { "encoding": "PCMU", "sample_rate": 8000, "channels": 1 }
  },
  "stream_id": "32DE0DEA-53CB-4B21-89A4-9E1819C043BC" }
```

```json
{ "event": "media", "sequence_number": "4",
  "media": { "track": "inbound/outbound", "chunk": "2", "timestamp": "5", "payload": "<base64>" },
  "stream_id": "32DE0DEA-53CB-4B21-89A4-9E1819C043BC" }
```

"The payload contains a base64-encoded RTP payload (no headers)." "The order of events is not guaranteed and the chunk number can be used to reorder the events."

```json
{ "event": "stop", "sequence_number": "5",
  "stop": { "user_id": "...", "call_control_id": "v2:..." },
  "stream_id": "32DE0DEA-53CB-4B21-89A4-9E1819C043BC" }
```

```json
{ "event": "mark", "stream_id": "...", "sequence_number": "5", "mark": { "name": "some_mark_name" } }
```

```json
{ "event": "dtmf", "stream_id": "...", "occurred_at": "2025-06-05T08:54:19.698408Z",
  "sequence_number": "5", "dtmf": { "digit": "1" } }
```

"`occurred_at` field is a timestamp captured on the Telephony engine side. These are consumed as asynchronous events and in certain circumstances *may* arrive out of order."

```json
{ "event": "error", "payload": { "code": integer, "title": string, "detail": string }, "stream_id": uuid }
```

Error codes: 100002 `unknown_error`, 100003 `malformed_frame`, 100004 `invalid_media` ("Media provided was not base64 encoded"), 100005 `rate_limit_reached` ("Too many requests").

Note the numeric fields (`sequence_number`, `chunk`, `timestamp`) are JSON strings in the examples.

### 4.4 Messages you send

Audio back to the Caller, RTP mode [quoted: MS]:

```json
{ "event": "media", "media": { "payload": "your base64 encoded RTP stream" } }
```

MP3 mode [quoted: MS]: `{ "event": "media", "media": { "payload": "your base64 encoded mp3 file" } }`. "Multiple media messages will be queued and played in the order they were submitted."

Clear queued audio (barge-in) [quoted: MS]: `{ "event": "clear" }`. "Sending a clear message will immediately stop the media playing on the stream and clear the media queue."

Mark [quoted: MS]: `{ "event": "mark", "mark": { "name": "some_mark_name" } }`. "When the media immediately preceding the mark finishes you will receive the same mark back." "Submitting marks when no audio is played or queued will result in them being immediately sent back. Similarly, the `clear` message will also result in all queued marks being sent back."

[inferred] Marks are the only documented way to know how much of a reply the Caller actually heard, which an engine needs in order to store only the spoken part of an interrupted reply.

Telnyx's own Node examples: https://github.com/team-telnyx/demo-node-telnyx/tree/master/websocket-demos/websocket , `.../websocket-deepgram-transcription` , `.../websoket-openai-demo` [quoted: MS, link list; repos not fetched].

---

## 5. Standalone speech APIs (usable outside a call)

| | Streaming STT (WebSocket) | Batch STT (REST) | Streaming TTS (WebSocket) | TTS (REST) |
| - | - | - | - | - |
| Endpoint | `wss://api.telnyx.com/v2/speech-to-text/transcription` (also `wss://transcription.telnyx.com/public/speech-to-text/transcription`) | `POST /v2/ai/audio/transcriptions` | `wss://api.telnyx.com/v2/text-to-speech/speech` | `POST https://api.telnyx.com/v2/text-to-speech/speech` |
| Auth | `Authorization: Bearer YOUR_API_KEY` on the upgrade request | Bearer API key; "OpenAI SDK compatible" with `base_url` `https://api.telnyx.com/v2` | `Authorization: Bearer <key>` header during the upgrade | `Authorization: Bearer <token>` |
| Config | Query string, locked at connect: `transcription_engine` (default Deepgram), `model`, `input_format` (default `mp3`), `sample_rate` (default 16000), `language` (default `en-US`), `interim_results`, `endpointing` (default 100 ms), Flux `eot_threshold` / `eot_timeout_ms` / `eager_eot_threshold`, `keyterm`, `redact`, `noise_suppression` | Multipart file or `file_url`; `model` | Query string: `voice`, `language`, `text_type`, `audio_format` (default `mp3`; `mp3`, `linear16`, `wav`, `mulaw`, `alaw`, `ogg_vorbis`), `sample_rate`, `disable_cache`; then `voice_settings` in the init frame | JSON body: `text`, `voice`, `output_type` (`binary_output` default, `base64_output`, `audio_id`), `language`, `text_type`, `voice_settings`, `pronunciation_dict_id`, `disable_cache` |
| Audio in / out | Binary frames, "raw bytes, chunked. No base64 or JSON wrapping." Telephony formats `mulaw`, `alaw` (any rate, default 8000), `g729`, `amr_nb`, `amr_wb`; raw `linear16` (s16le), `linear32`, `opus`; containers `mp3`, `wav`, `flac`, `webm`, `ogg`. "Universal formats (all engines and models): `linear16`." "Recommended chunk size: 2048–8192 bytes." | "File size limit | 100 MB" | Client sends JSON text frames; server returns JSON with Base64 audio: `{"audio":"<b64>","text":...,"isFinal":false}` | Chunked HTTP audio (`Content-Type: audio/mpeg`), or `{"base64_audio": ...}`, or `{"audio_url": ...}` |
| Protocol | Client text frames `{"type":"Finalize"}`, `{"type":"CloseStream"}`, `{"type":"KeepAlive"}`. Server: `{"transcript","is_final","speech_final","confidence"}`, utterance end `{"transcript":"","is_final":true,"utterance_end":true}` (Deepgram), `{"errors":[...]}` | Synchronous; "Async / webhooks | No" | Init frame `{"text": " "}`; text `{"text": "Hello."}`; `{"text":"...","flush":true}`; `{"force": true}` ("interrupt current synthesis (barge-in), restart worker"); `{"text": ""}` ends. Final frame `{"audio":null,"text":"","isFinal":true}` | "The connection stays open until synthesis completes or 30 seconds pass with no new chunks." |
| Engines / voices | Deepgram (`nova-3` default, `nova-3-medical`, `nova-2`, `flux`, `flux-multi`), Telnyx (`openai/whisper-tiny`), Google (`latest_long`), Azure (`azure/fast`), xAI, AssemblyAI, Speechmatics, Soniox, Parakeet, Cohere, Reson8, Humain | Whisper, Deepgram, Parakeet, Reson8 models | `Provider.Model.VoiceId`; Telnyx KokoroTTS / Qwen3TTS / Bayan, Minimax, Resemble, Inworld, AWS Polly, Azure, ElevenLabs (BYOK), Soniox | Same voice format; Telnyx Ultra is documented as REST-only |
| Notes | Interim results: "**Deepgram, Speechmatics, and Soniox.** Other engines ignore this parameter." | | "Text is buffered and synthesized at sentence boundaries." "Markdown formatting is automatically stripped before synthesis". For AWS Polly and Azure, audio is in the text-bearing chunk; for others, in separate frames with `text: null` | "Markdown is automatically stripped." |

Sources: https://developers.telnyx.com/docs/voice/stt/websocket-streaming.md , `.../stt/websocket-streaming/parameters.md` , `.../parameters/audio-formats.md` , `.../parameters/engines-and-models.md` , `.../parameters/interim-results.md` , `.../stt/websocket-streaming/responses.md` , `.../stt/rest-api.md` , https://developers.telnyx.com/docs/voice/tts/websocket-streaming.md , `.../tts/websocket-streaming/configuration.md` , `.../tts/websocket-streaming/messages.md` , `.../tts/websocket-streaming/errors.md` (auth row: "Connection rejected (401) | Missing auth | Pass `Authorization: Bearer <key>` header during WebSocket upgrade") , `.../tts/rest-api.md` , `.../tts/rest-api/request.md` , `.../tts/rest-api/response.md`. All quotes in the table are from those pages.

[inferred] A raw-audio design can be all-Telnyx: media stream (PCMU 8 kHz in) -> STT WebSocket with `input_format=mulaw&sample_rate=8000` -> engine -> TTS WebSocket with `audio_format=mulaw` (or `linear16`) -> `media` frames back. The TTS WebSocket needs an `Authorization` header on the upgrade, which browsers cannot set but Node clients can.

---

## 6. The official Node SDK

- Package: `telnyx` on npm. [quoted: https://registry.npmjs.org/telnyx/latest] `"name": "telnyx"`, `"version": "7.31.0"`, `"description": "The official TypeScript library for the Telnyx API"`, `"license": "MIT"`, `"types": "./index.d.ts"`, `"type": "commonjs"`, `"dependencies": {}`, `"peerDependencies": {"ws": "^8.18.0"}` with `"peerDependenciesMeta": {"ws": {"optional": true}}`. Current major: **7**. Repo: https://github.com/team-telnyx/telnyx-node.
- TypeScript-first: yes. [quoted: https://developers.telnyx.com/docs/development/sdk/node.md] "The official telnyx package provides a typed TypeScript and Node.js client generated from the same OpenAPI definition as the API reference." Source files are headed "File generated from our OpenAPI spec by Stainless." [quoted: SDK webhooks.ts].
- Runtime. [quoted: sdk/node.md] "TypeScript >= 4.9 is supported." "Node.js 20 LTS or later (non-EOL) versions." Also Deno >= 1.28, Bun >= 1.0, Cloudflare Workers, Vercel Edge. The npm manifest declares no `engines` field (registry value is null). Node 24 is inside the supported range. [inferred]
- Typed Call Control commands: yes. [quoted: https://developers.telnyx.com/docs/development/sdk/node/resource-map.md] rows "`client.calls.actions.answer()` | `POST /calls/{call_control_id}/actions/answer`", `client.calls.actions.hangup()`, `.speak()`, `.stopPlayback()`, `.startStreaming()`, `.startTranscription()`, `.transfer()`, `.bridge()`; and `client.calls.dial()`.
- Webhook helper: yes. [quoted: https://developers.telnyx.com/docs/development/sdk/node/webhooks.md] "Pass the raw request body and the request headers to `client.webhooks.unwrap()`." "`unwrap()` throws when the signature does not match, and returns the parsed event as a typed union of every webhook event the API sends". "`client.webhooks.unsafeUnwrap(body)` parses a payload without checking the signature." Public key from `TELNYX_PUBLIC_KEY` or the `publicKey` client option. Implementation uses WebCrypto, no dependency: [quoted: SDK lib/webhooks.ts] "This class provides Ed25519 signature verification for Telnyx webhooks using Node's built-in crypto module (no external dependencies)." It does a `crypto.subtle.importKey('raw', ...)` + `subtle.verify` and enforces the 300-second tolerance.
- **`unwrap` is async.** [quoted: https://raw.githubusercontent.com/team-telnyx/telnyx-node/master/src/resources/webhooks.ts] "async unwrap( body: string, { headers, key }: { headers: Record<string, string>; key?: string }, ): Promise<UnwrapWebhookEvent>". The docs page and README call it without `await` inside a synchronous `try/catch` (see Contradictions).
- Retries and timeouts. [quoted: https://developers.telnyx.com/docs/development/sdk/node/errors-and-retries.md] "Certain errors will be automatically retried 2 times by default, with a short exponential backoff. Connection errors ..., 408 Request Timeout, 409 Conflict, 429 Rate Limit, and >=500 Internal errors will all be retried by default." "Requests time out after 1 minute by default." [inferred] For Call Control, set `maxRetries` and `timeout` explicitly and always send a `command_id`, otherwise an SDK retry of `speak` or `transfer` can double-execute; and [quoted: https://developers.telnyx.com/docs/development/api-fundamentals/reliability/command-retries.md] "Application retries and SDK retries can multiply each other; keep one bounded retry budget for the complete operation."
- Plain `fetch` + built-in crypto as an alternative. Documented as legitimate: [quoted: https://developers.telnyx.com/docs/development/sdk.md] "Direct HTTP | Endpoint tests, unsupported runtimes, or API capabilities not yet available in an SDK release" and "Use direct HTTP when an API capability is available before the matching SDK release." For verification: [quoted: call-control-migration-guide.md] "You can then use cryptographic libraries in your language of choice to verify the signature using the public key." [inferred] It is reasonable: the commands are small JSON POSTs with a Bearer key, and verification is one Ed25519 check over `${timestamp}|${rawBody}` with a 32-byte raw public key. With `node:crypto` the raw key must first become a `KeyObject` (for example `createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: <base64url of the key> }, format: 'jwk' })`, then `crypto.verify(null, data, keyObject, signature)`), or use `crypto.subtle` exactly as the SDK does. (The `node:crypto` call shapes are from memory, unverified against Node 24 docs.) Telnyx does not document a `crypto.verify` recipe itself.

---

## 7. Transfers and bridging to a human

### `transfer`

`POST /v2/calls/{call_control_id}/actions/transfer`. [quoted: OAS] "Transfer a call to a new destination. If the transfer is unsuccessful, a `call.hangup` webhook for the other call (Leg B) will be sent indicating that the transfer could not be completed. The original call will remain active and may be issued additional commands, potentially transfering the call to an alternate destination." Expected webhooks: "`call.initiated`", "`call.bridged` to Leg B", "`call.answered` or `call.hangup`", plus AMD events if requested.

Key fields [schema: OAS `TransferCallRequest`], required `to`:
- `to`: "The DID or SIP URI to dial out to."
- `from`: "This attribute will default to the `to` number of the original call if omitted."
- `timeout_secs` (default 30): "If the timeout is reached before an answer is received, the call will hangup and a `call.hangup` webhook with a `hangup_cause` of `timeout` will be sent. Minimum value is 5 seconds. Maximum value is 600 seconds."
- `time_limit_secs` (default 14400, 30 to 14400).
- `audio_url` / `media_name`: "to be played back when the transfer destination answers before bridging the call."
- `target_leg_client_state`: "Use this field to add state to every subsequent webhook for the new leg."
- `park_after_unbridge`: "If supplied with the value `self`, the current leg will be parked after unbridge. If not set, the default behavior is to hang up the leg."
- `early_media` (default true), `answering_machine_detection`, `mute_dtmf`, `record`, `sip_region` (`US` default, `Europe`, `Canada`, `Australia`, `Middle East`), `webhook_url`, `webhook_retries_policies`, `command_id`.

Reading the outcome [inferred from the above]:
- Success: `call.initiated` (new leg B, shares `call_session_id`, has its own `call_control_id`), `call.answered` for leg B, `call.bridged` for the legs.
- No answer: `call.hangup` for leg B with `hangup_cause: "timeout"`; the Caller's leg stays up and you can speak again or try another destination.
- Busy / rejected / not found: `call.hangup` for leg B with `user_busy`, `call_rejected`, `not_found` (enum in 1.3).
- Which leg a webhook belongs to: match `call_leg_id` / `call_control_id`, and use `target_leg_client_state` to label leg B.

### `dial` + `bridge` (two-step, lets you screen or whisper first)

- `POST /v2/calls` with required `connection_id`, `to`, `from`. [quoted: OAS] "Dial a number or SIP URI from a given connection. A successful response will include a `call_leg_id` which can be used to correlate the command with subsequent webhooks." Expected: `call.initiated`, then "`call.answered` or `call.hangup`".
- Linking fields [schema: OAS `CallRequest`]: `link_to` ("Use another call's control id for sharing the same call session id"), `bridge_intent` ("Indicates the intent to bridge this call with the call specified in link_to. ... the from number will be overwritten by the from number from the linked call."), `bridge_on_answer` ("Whether to automatically bridge answered call to the call specified in link_to."), `timeout_secs` (default 30, 5 to 600), `retry_on_timeout` (default true: "When set to `false`, reaching `timeout_secs` aborts the entire dial attempt and the `call.hangup` webhook reports a `hangup_cause` of `no_answer` instead of `timeout`.").
- `POST /v2/calls/{call_control_id}/actions/bridge` with body `call_control_id` of the other leg. [quoted: OAS] "Bridge two call control calls." Expected: "`call.bridged` for Leg A", "`call.bridged` for Leg B". Options: `park_after_unbridge`, `hold_after_unbridge`, `play_ringtone`, `ringtone`, `prevent_double_bridge`, `queue`.
- Outbound caller id must be yours: [quoted: get-started.md] "Outbound calls are rejected (error D35, \"Caller Origination Number is Invalid\") when `from` is not a number on your account." (see also the `diversion` field on transfer.)
- SIP REFER also exists (`/actions/refer`, events `call.refer.started/completed/failed`); not explored.

Cost: [quoted: PRICE] "Call transfer | $0.10 per invocation".

---

## 8. Operations

### Regions, anchor sites, hosting

- Anchor site default is latency-based. [schema: OAS `anchorsite_override`] "`Latency` directs Telnyx to route media through the site with the lowest round-trip time to the user's connection. Telnyx calculates this time using ICMP ping messages. This can be disabled by specifying a site to handle all media." Enum on a Call Control application: `Latency`, `Chicago, IL`, `Ashburn, VA`, `San Jose, CA`, `London, UK`, `Chennai, IN`, `Amsterdam, Netherlands`, `Toronto, Canada`, `Sydney, Australia`.
- Regional REST endpoints. [quoted: https://developers.telnyx.com/docs/account-setup/regional-endpoints.md] table: `api.telnyx.com` North America (Ashburn, Chicago, San Jose); `api.telnyx.eu` Europe (Frankfurt); `api.telnyx.com.au` APAC (Sydney); `api.telnyx.ca` Canada (Toronto); `api.telnyx.me` Middle East (Dubai). "Regional endpoints work with the same API keys, the same request and response shapes, and the same webhook payloads as `api.telnyx.com`." Webhooks do not move: "deliveries originate from the same webhook infrastructure regardless of the endpoint used to submit the request."
- Europe. [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-services-in-europe.md] "To receive Voice API calls in Europe, Telnyx users should set the AnchorSite® for the application to one of the European Anchorsites—either Frankfurt, London or Amsterdam."
- Hosting guidance for your own webhook / WebSocket server: none found for the Voice API. The nearest statement is for TeXML: [quoted: https://developers.telnyx.com/docs/voice/sip-trunking/routing/anchorsite-configuration.md] "TeXML: PoP selected based on latency to webhook URL IP." [inferred] Host near the anchor site that will carry the media (for US callers, one of Ashburn / Chicago / San Jose). [unverified] Where Telnyx's webhook senders and media-stream WebSocket clients originate from, and any IP ranges to allow-list.
- Data residency: storage location is a separate, "account-level, one-time, irreversible choice" [quoted: regional-endpoints.md].

### Local development

- [quoted: WHF] "For local testing, expose a local handler with the ngrok setup guide. Do not send production payloads containing sensitive data to public request-inspection services." Guide: https://developers.telnyx.com/docs/development/development-tools/ngrok-setup.md ("Copy the https forwarding address, as you'll need it to configure your Mission Control Portal."). [inferred] The media stream needs a publicly reachable `wss://` URL too; a tunnel that supports WebSocket upgrade works, and the per-command `webhook_url` override plus `stream_url` let one application serve several developers.

### Numbers for inbound voice

- Buy a number with the Voice feature and assign it to the application (1.1). Search filters: "Features (SMS, Voice, Fax, etc)", "Number type (Local, Toll-Free, etc.)" [quoted: buy-phone-number.md].
- Regulatory documents depend on the country: https://developers.telnyx.com/docs/numbers/phone-numbers/regulatory-requirements.md and the portal compliance page (linked from `.../phone-numbers/getting-started.md`; not read in detail). [unverified] Specific requirements for a given country.
- Inbound concurrency: `inbound.channel_limit` on the application ("When set, this will limit the total number of inbound calls to phone numbers associated with this connection.") [schema: OAS].

### Rate limits

- General REST. [quoted: https://developers.telnyx.com/docs/development/api-fundamentals/reliability/rate-limiting.md] "Most `api.telnyx.com` endpoints enforce rate limits. Limits and scopes can differ by product and operation ... Treat response headers and product documentation as authoritative rather than hard-coding a global request rate." Headers `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `retry-after`; 429 body code `10011`. "Limits are counted per region."
- Voice command rate (commands per second per call or account): not published. "Do not infer Messaging limits for Voice" [quoted: same page]. [unverified]
- Outbound dials only. [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/dials-per-second-limit.md] "By default, every account is limited to **30 dials per second**." Calculated "over **fixed 5-second windows**"; error `90103`.
- Media stream: error 100005 `rate_limit_reached`; MP3 mode "once per second" (4.1).
- L1-verified accounts. [quoted: l1-accounts-restirctions.md] "Limited to a maximum of 100 outbound calls a day." "Limited to 10 outbound calls per hour." plus the spoken prefix (3.2).

### Recording and consent

- `POST /v2/calls/{call_control_id}/actions/record_start`. [quoted: OAS] "Start recording the call. Recording will stop on call hang-up, or can be initiated via the Stop Recording command." Events: `call.recording.saved`, `call.recording.transcription.saved`, `call.recording.error`. Or on `answer`: `record: "record-from-answer"`, `record_channels` (`single` | `dual`, default `dual`), `record_format` (`wav` | `mp3`, default `mp3`), `record_track`, `record_max_length` (max 43200 s), `record_redaction` (`pci`, `pii`, `phi`; "Redaction works on English speech only. Redacted recordings are charged at the Deepgram speech-to-text rate.").
- Storage and links. [quoted: https://developers.telnyx.com/docs/voice/programmable-voice/storing-call-recordings.md] "Call recordings are automatically stored in S3 buckets owned by Telnyx, but users can opt to store recordings in their own S3 or GCS buckets instead." "The link to the recording is active for 10 minutes."
- Consent: nothing. A search for "consent" across the whole Voice API docs bundle (`https://developers.telnyx.com/public/llms/calling/voice-api-full.txt`) returned no hits about recording. [unverified] Telnyx publishes no consent-announcement guidance in the developer docs; this is the implementer's legal question.

### Published pricing (US list, pay as you go; all quoted from PRICE unless noted)

| Item | Price |
| - | - |
| Voice API, inbound to a local number | "Local number | $0.002 per minute + the SIP Trunking fee for inbound calls" |
| Voice API, outbound | "Make outbound calls | $0.002 per minute + the SIP Trunking fee for outbound calls" |
| SIP trunking fee, inbound local | "Local calls | Starting at $0.0032 per minute" [quoted: https://telnyx.com/pricing/elastic-sip] |
| SIP trunking fee, outbound local | "Local calls | Starting at $0.005 per minute" [quoted: https://telnyx.com/pricing/elastic-sip] |
| Local number | "Local numbers | From $1 per month" [quoted: https://telnyx.com/pricing/numbers] |
| Media streaming | "Media Streaming over WebSockets | $0.0035 per minute" |
| Conversation Relay | "Conversation Relay | $0.05 per minute" |
| Call transfer | "Call transfer | $0.10 per invocation" |
| Recording | "Call recording | $0.002 per minute"; "Call recording storage | $0 per minute" |
| Transcription (STT) | "Telnyx STT | $0.015 per minute"; "Deepgram Nova 2 STT | $0.005 per minute"; "Deepgram Nova 3 STT | $0.005 per minute"; "Deepgram Flux STT | $0.005 per minute"; "Google STT | $0.017 per minute"; "Azure STT | $0.027 per minute"; "AssemblyAI STT | $0.005 per minute"; "Soniox STT | $0.002 per minute"; "Parakeet STT | $0.0015 per minute" |
| Speak (TTS) | "Telnyx TTS | $0.000003 per character"; "Standard TTS (Amazon Polly) | $0.000009 per character"; "Neural Voices TTS (Amazon Polly) | $0.000024 per character"; "Telnyx Ultra | $0.000032 per character"; "Qwen3TTS | $0.000032 per character"; "MiniMax speech-2.8-turbo TTS | $0.000034 per character"; "ElevenLabs TTS | BYO API key (billed by ElevenLabs)"; "Azure Neural HD TTS | BYO API key (billed by Azure)" |
| Noise suppression | "Noise Suppression | $0.002 per leg per minute" |
| Emergency calling | "Emergency calling | $1.5 per month, per number" [quoted: elastic-sip page] |

Worked example on the page: "100,000 MINUTES, 60% OUTBOUND | Voice API | 100,000 × $0.002 | $200 | SIP trunk · outbound | 60,000 × $0.005 | $300 | SIP trunk · inbound | 40,000 × $0.0032 | $128". Caveat on the page: "Published rates, pay as you go, before volume tiers. Carrier passthrough and taxes vary by destination." Machine-readable: "GET /v2/public/pricing?primitive=voice" (not fetched).

[inferred] Raw-audio route, inbound US local, per minute: 0.002 (Voice API) + 0.0032 (trunk) + 0.0035 (media streaming) = about $0.0087, before your own STT/TTS. Webhook route: 0.002 + 0.0032 + STT (for example 0.005 Deepgram) = about $0.0102 plus TTS per character.

---

## 9. Third-party voice frameworks on Telnyx telephony (names and URLs only)

Published by Telnyx:
- LiveKit over Telnyx SIP trunks: https://developers.telnyx.com/docs/voice/sip-trunking/livekit-configuration-guide.md
- Telnyx LiveKit Plugin (Telnyx STT/TTS/LLM inside LiveKit agents): https://developers.telnyx.com/docs/inference/livekit.md and https://github.com/team-telnyx/telnyx-livekit-plugin
- LiveKit on Telnyx (Beta) (hosted LiveKit agents): https://developers.telnyx.com/docs/livekit.md , telephony page https://developers.telnyx.com/docs/livekit/telephony.md . That page carries a warning: "**LiveKit on Telnyx is being retired.** Run your agents on LiveKit Cloud or your own LiveKit deployment with the Telnyx-maintained `telnyx-livekit-plugin`."
- OpenAI GPT-Live over SIP: https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide.md
- Pipecat: only a link from the media streaming guide, "Pipecat Telnyx Chatbot in Python": https://github.com/pipecat-ai/pipecat-examples/tree/main/telnyx-chatbot (uses the media-stream WebSocket, not SIP). No Telnyx-authored Pipecat guide was found in the docs index.
- Vapi, ElevenLabs, Retell: Telnyx documents only importing their assistants into Telnyx AI Assistants: https://developers.telnyx.com/docs/inference/ai-assistants/importing.md . ElevenLabs also appears as a TTS provider: https://developers.telnyx.com/docs/voice/tts/providers/elevenlabs.md
- SIP trunking configuration guides index: https://developers.telnyx.com/docs/voice/sip-trunking/configuration-guides.md (contains no Pipecat / Vapi / ElevenLabs / Retell entries; checked by text search)

Published by the other vendor (found by search, not fetched, not verified):
- ElevenLabs Agents, Telnyx SIP trunking: https://elevenlabs.io/docs/agents-platform/phone-numbers/telephony/telnyx
- Vapi, Telnyx SIP: https://docs.vapi.ai/advanced/sip/telnyx

---

## Contradictions and gaps in the docs

Contradictions:

1. **Webhook envelope in "Getting Started" does not match the v2 envelope.** GS shows events as a flat object with `created_at`, `event_type`, `payload`, `record_type`, `webhook_id` and no `data` / `meta`, while WH and RW show `{ "data": { "id", "event_type", "occurred_at", "payload" }, "meta": {...} }`. The storing-call-recordings page shows the same flat shape with `"event_type": "recording_saved"` (v1 naming). Combined with the API default `webhook_api_version: "1"`, an application created over REST without setting the version will receive the wrong shape and an HMAC-era signature scheme. The portal text says "v2 recommended".
2. **Success status: 200 or any 2xx.** WH: "2xx | Success". OAS webhooks: "The server must return an HTTP 200, otherwise we will reattempt delivery at the failover webhook URL." RW: "returns a non 200 OK response".
3. **When failover happens.** GS: "fails after two consecutive delivery attempts". RW: on the first non-200 or unresolvable URL. WH's flowchart: straight from primary failure to failover with no retry step, yet its response-code table says 408 / 429 / 5xx are "Retried".
4. **Where retry details live.** WH: "For details on retry logic, signature verification, and general webhook behavior, see Webhook Fundamentals", linking to an anchor `#webhook-signing` that the target page does not have. WHF in turn says "Product-specific policies determine retry timing, timeout, and failover destinations." Neither page gives a schedule.
5. **`command_id` window.** Guides: "within 60 seconds". API reference: "Telnyx will ignore any command with the same `command_id` for the same `call_control_id`" with no window.
6. **Command retry advice.** Voice command-retries page: "immediately retry the command" on 500 and resend after 500 ms without a response. Fundamentals reliability page: "Do not automatically retry a timed-out `POST` that can place a call ... First reconcile the resource or action state" and use "exponential backoff with jitter".
7. **Node SDK `unwrap` is async but documented as sync.** Source: `async unwrap(...): Promise<UnwrapWebhookEvent>`. The docs page and the README write `const event = client.webhooks.unwrap(req.body, {...})` inside `try { ... } catch { res.sendStatus(400) }` with no `await`. As written, `event` is a Promise, `event.data?.event_type` is `undefined`, the handler replies 200 before verification finishes, and a bad signature becomes an unhandled rejection instead of a 400. (The JSDoc in `lib/webhooks.ts` does show `await`.) The docs example also casts `req.headers` to `Record<string, string>`.
8. **Media stream codecs and rates.** MS lists fixed pairs ("L16, 16 kHz", "G722, 8 kHz", "OPUS, 8 kHz, 16 kHz"). The reference has a separate `stream_bidirectional_sampling_rate` with 8000, 16000, 22050, 24000, 48000 and default 8000, which contradicts "L16, 16 kHz" unless the rate must be set explicitly. MS never mentions `stream_codec`, `stream_bidirectional_target_legs`, `stream_bidirectional_sampling_rate`, `custom_parameters` or `stream_auth_token`.
9. **Default bidirectional mode.** MS presents RTP first; the schema default is `mp3`. Omitting `stream_bidirectional_mode` and sending PCM gets `invalid_media` or silence. [inferred]
10. **Media stream curl examples are malformed** (curly quotes, a stray `}'` before `stream_bidirectional_mode`), and the `call.answered` example lists `"stream_track":"inbound_track|outbound_track|both_tracks"` as if it were a value.
11. **Polly voice naming.** tts.md and gather-using-ai.md use `Polly.Brian` / `Polly.Amy-Neural`; the reference says `AWS.Polly.<VoiceId>`, while the `language` field says "ignored when a `Polly.*` voice is specified".
12. **Telnyx Ultra availability.** available-voices.md: "REST API only." in-call-playback.md: "All models (including Ultra) are available for in-call playback." tts.md shows Ultra on `speak`. Language count is 44 on two pages and 38 in the docs index. (The Ultra `speak` examples in tts.md and in-call-playback.md also omit the required `payload`.)
13. **Voices endpoint.** `GET /v2/ai/tts/voices` (TTS WebSocket configuration page) vs `GET https://api.telnyx.com/v2/text-to-speech/voices` (available-voices page).
14. **Interim results support.** In-call guide credits Google with "additional features like interim results" and the schema gives `interim_results` to Google, Deepgram, AssemblyAI; the standalone STT page says "**Deepgram, Speechmatics, and Soniox.** Other engines ignore this parameter." These are different surfaces, but the engine lists claim to be the same.
15. **Default STT engine.** In-call `transcription_start`: Google. Standalone STT WebSocket: Deepgram. AssemblyAI default model id is `assemblyai/universal-3-5-pro` in the schema and `assemblyai/universal-3-6-pro` in the WebSocket engines table (documented as aliases).
16. **Anchor site lists.** Call Control application enum has 8 sites and no Frankfurt; the Europe guide says "Frankfurt, London or Amsterdam"; the SIP anchor-site page lists 13 PoPs.
17. **Pricing page self-contradiction.** Rate card: "$0.002 per minute + the SIP Trunking fee"; comparison table on the same page: "Telnyx | $0.007 out | per min, US, list".
18. **Stale links.** Hangup in two guide tables links to the TeXML `<Hangup>` verb page, not the Call Control hangup reference. The per-event "Callbacks" reference pages (`/api-reference/callbacks/*.md`) render with an empty `paths: {}`; payload schemas are only in the OpenAPI JSON `webhooks` section.

Gaps (not stated anywhere I fetched):

- The webhook retry count, spacing and default timeout for Voice, and whether a retried delivery keeps the same `data.id`.
- A recommended signature timestamp tolerance (only the SDK's hard-coded 300 s).
- What a duplicate `command_id` returns.
- How `stream_auth_token` and `custom_parameters` reach your server on the media socket.
- Whether audio you send in RTP mode must be bare codec payload or full RTP packets ("your base64 encoded RTP stream" vs inbound "RTP payload (no headers)"), the expected frame size and pacing (only "20 milliseconds to 30 seconds"), and L16 byte order. (From memory, unverified: RTP L16 is big-endian per RFC 3551; Telnyx does not say.)
- What `stream_bidirectional_target_legs` `self` / `opposite` mean for a single-leg inbound call where the Caller is the only party; the default is `opposite`.
- Whether `speak` / `playback_start` can be used while a media stream is active. The shared 422 examples include code 90045 "Media Streaming is used ... This command can't be issued when media streaming is used." without saying which commands.
- What `call.speak.ended.status` is after `playback_stop`, and whether the stopped text position is reported (it is not in the schema).
- End-of-turn signalling in `call.transcription` webhooks (none in the schema, even for Deepgram Flux).
- Latency figures for webhook delivery, `speak` time-to-first-audio, or the transcription webhook path.
- What happens to an unanswered inbound call when `first_command_timeout` is off (how long it stays parked).
- Source IP ranges for webhooks and media-stream connections; hosting-region guidance for a Voice API server.
- Voice command rate limits.
- Call-recording consent guidance.
- Whether the TTS/STT WebSocket accept the API key any way other than the `Authorization` header.

---

## URLs fetched

All returned HTTP 200 and non-empty content unless noted. Fetched with curl as raw text.

Indexes and machine-readable sources:
- https://developers.telnyx.com/llms.txt
- https://developers.telnyx.com/public/llms/calling/voice-api.txt
- https://developers.telnyx.com/public/llms/calling/voice-api-full.txt (searched, not read end to end)
- https://developers.telnyx.com/public/llms/calling.txt
- https://developers.telnyx.com/public/llms/voice.txt
- https://developers.telnyx.com/public/llms/voice/stt.txt
- https://developers.telnyx.com/public/llms/voice/tts.txt
- https://developers.telnyx.com/public/llms/development.txt
- https://developers.telnyx.com/public/llms/development-full.txt (searched only)
- https://developers.telnyx.com/public/llms/fundamentals.txt
- https://developers.telnyx.com/public/llms/ai.txt
- https://developers.telnyx.com/public/llms/ai/livekit.txt
- https://developers.telnyx.com/public/llms/numbers.txt
- https://developers.telnyx.com/openapi/source/external/call-control/call-control.json
- https://developers.telnyx.com/data/webhook-events.json (loaded; only its header was inspected)

Voice API guides:
- https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-fundamentals.md
- https://developers.telnyx.com/docs/voice/programmable-voice/get-started.md
- https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-commands-and-resources.md
- https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks.md
- https://developers.telnyx.com/docs/voice/programmable-voice/sending-commands.md
- https://developers.telnyx.com/docs/voice/programmable-voice/receiving-webhooks.md
- https://developers.telnyx.com/docs/voice/programmable-voice/command-retries.md
- https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming.md
- https://developers.telnyx.com/docs/voice/programmable-voice/speech-to-text.md
- https://developers.telnyx.com/docs/voice/programmable-voice/tts.md
- https://developers.telnyx.com/docs/voice/programmable-voice/gather-using-ai.md
- https://developers.telnyx.com/docs/voice/programmable-voice/ai-assistant-start.md
- https://developers.telnyx.com/docs/voice/programmable-voice/conversation-relay.md (downloaded, not read: other researcher's scope)
- https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-services-in-europe.md
- https://developers.telnyx.com/docs/voice/programmable-voice/l1-accounts-restirctions.md
- https://developers.telnyx.com/docs/voice/programmable-voice/storing-call-recordings.md
- https://developers.telnyx.com/docs/voice/programmable-voice/dials-per-second-limit.md

API reference pages (each embeds the OpenAPI operation; the schema was read from the OpenAPI JSON above):
- https://developers.telnyx.com/api-reference/call-commands/answer-call.md
- https://developers.telnyx.com/api-reference/call-commands/hangup-call.md
- https://developers.telnyx.com/api-reference/call-commands/reject-a-call.md
- https://developers.telnyx.com/api-reference/call-commands/speak-text.md
- https://developers.telnyx.com/api-reference/call-commands/stop-audio-playback.md
- https://developers.telnyx.com/api-reference/call-commands/gather-using-speak.md
- https://developers.telnyx.com/api-reference/call-commands/gather-using-ai.md
- https://developers.telnyx.com/api-reference/call-commands/start-ai-assistant.md
- https://developers.telnyx.com/api-reference/call-commands/streaming-start.md
- https://developers.telnyx.com/api-reference/call-commands/streaming-stop.md
- https://developers.telnyx.com/api-reference/call-commands/transcription-start.md
- https://developers.telnyx.com/api-reference/call-commands/transfer-call.md
- https://developers.telnyx.com/api-reference/call-commands/bridge-calls.md
- https://developers.telnyx.com/api-reference/call-commands/dial.md
- https://developers.telnyx.com/api-reference/call-commands/recording-start.md
- https://developers.telnyx.com/api-reference/call-commands/update-client-state.md
- https://developers.telnyx.com/api-reference/call-control-applications/create-a-call-control-application.md
- https://developers.telnyx.com/api-reference/webhooks/list-webhook-deliveries.md
- https://developers.telnyx.com/api-reference/callbacks/call-initiated.md , call-answered.md , call-hangup.md , call-bridged.md , transcription.md , call-speak-started.md , call-speak-ended.md , call-streaming-started.md , call-streaming-failed.md (all loaded but contain no payload schema: `paths: {}`)

Fundamentals, SDK, operations:
- https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks.md
- https://developers.telnyx.com/docs/development/api-fundamentals/reliability/command-retries.md
- https://developers.telnyx.com/docs/development/api-fundamentals/reliability/rate-limiting.md
- https://developers.telnyx.com/docs/development/api-fundamentals/api-errors.md (downloaded, not read)
- https://developers.telnyx.com/docs/development/api-fundamentals/authentication.md (downloaded, not read)
- https://developers.telnyx.com/docs/development/api-fundamentals/create-api-keys.md (downloaded, not read)
- https://developers.telnyx.com/docs/development/migration/call-control-migration-guide.md
- https://developers.telnyx.com/docs/development/sdk.md
- https://developers.telnyx.com/docs/development/sdk/node.md
- https://developers.telnyx.com/docs/development/sdk/node/webhooks.md
- https://developers.telnyx.com/docs/development/sdk/node/errors-and-retries.md
- https://developers.telnyx.com/docs/development/sdk/node/resource-map.md (searched)
- https://developers.telnyx.com/docs/development/development-tools/ngrok-setup.md
- https://developers.telnyx.com/docs/account-setup/regional-endpoints.md
- https://developers.telnyx.com/docs/voice/sip-trunking/routing/anchorsite-configuration.md
- https://developers.telnyx.com/docs/numbers/phone-numbers/buy-phone-number.md
- https://developers.telnyx.com/docs/numbers/phone-numbers/getting-started.md
- https://developers.telnyx.com/docs/inference/data-residency.md (downloaded, not read)
- https://developers.telnyx.com/docs/voice/sip-trunking/features/external-transfers.md (downloaded, not read)

Standalone speech:
- https://developers.telnyx.com/docs/voice/stt/overview.md
- https://developers.telnyx.com/docs/voice/stt/models.md (downloaded, not read)
- https://developers.telnyx.com/docs/voice/stt/websocket-streaming.md
- https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters.md
- https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters/audio-formats.md
- https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters/engines-and-models.md
- https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters/interim-results.md
- https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters/end-of-turn.md (downloaded, not read)
- https://developers.telnyx.com/docs/voice/stt/websocket-streaming/responses.md
- https://developers.telnyx.com/docs/voice/stt/websocket-streaming/errors.md (searched)
- https://developers.telnyx.com/docs/voice/stt/websocket-streaming/pricing.md
- https://developers.telnyx.com/docs/voice/stt/in-call-transcription.md
- https://developers.telnyx.com/docs/voice/stt/rest-api.md
- https://developers.telnyx.com/docs/voice/tts/overview.md
- https://developers.telnyx.com/docs/voice/tts/available-voices.md
- https://developers.telnyx.com/docs/voice/tts/websocket-streaming.md
- https://developers.telnyx.com/docs/voice/tts/websocket-streaming/configuration.md
- https://developers.telnyx.com/docs/voice/tts/websocket-streaming/messages.md
- https://developers.telnyx.com/docs/voice/tts/websocket-streaming/examples.md (searched)
- https://developers.telnyx.com/docs/voice/tts/websocket-streaming/errors.md (searched)
- https://developers.telnyx.com/docs/voice/tts/rest-api.md
- https://developers.telnyx.com/docs/voice/tts/rest-api/request.md
- https://developers.telnyx.com/docs/voice/tts/rest-api/response.md
- https://developers.telnyx.com/docs/voice/tts/rest-api/pricing.md
- https://developers.telnyx.com/docs/voice/tts/in-call-playback.md

Third-party frameworks:
- https://developers.telnyx.com/docs/voice/sip-trunking/livekit-configuration-guide.md (headings only)
- https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide.md (headings only)
- https://developers.telnyx.com/docs/voice/sip-trunking/configuration-guides.md (searched)
- https://developers.telnyx.com/docs/inference/livekit.md
- https://developers.telnyx.com/docs/livekit/telephony.md
- https://developers.telnyx.com/docs/livekit/regions.md (downloaded, not read)
- https://developers.telnyx.com/docs/inference/ai-assistants/importing.md

SDK repo and npm:
- https://registry.npmjs.org/telnyx/latest
- https://raw.githubusercontent.com/team-telnyx/telnyx-node/master/README.md
- https://raw.githubusercontent.com/team-telnyx/telnyx-node/master/package.json
- https://raw.githubusercontent.com/team-telnyx/telnyx-node/master/src/resources/webhooks.ts
- https://raw.githubusercontent.com/team-telnyx/telnyx-node/master/src/lib/webhooks.ts

Pricing (raw HTML, text extracted locally):
- https://telnyx.com/pricing/call-control (200; redirects to https://telnyx.com/pricing/voice-api)
- https://telnyx.com/pricing/voice-api
- https://telnyx.com/pricing/elastic-sip
- https://telnyx.com/pricing/numbers
- https://telnyx.com/pricing/speech-to-text and https://telnyx.com/pricing/text-to-speech (read through the WebFetch summariser only; their figures matched the voice-api page)

Failed or not fetched:
- No fetch failed. Not fetched: the GitHub demo repos linked from the media streaming guide, the ElevenLabs and Vapi pages found by search, `GET /v2/public/pricing`, the country-specific regulatory requirement pages.
- One web search was run (product names only) to look for Telnyx-published Pipecat / Vapi / ElevenLabs guides; it returned only the other vendors' pages.
