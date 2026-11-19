# Telnyx TeXML: request/response voice loop, as documented

Date fetched: 2026-11-16. Source: developers.telnyx.com (page markdown via the `.md` suffix, the `llms.txt` indexes, the published OpenAPI source for TeXML callbacks) and telnyx.com pricing. The raw copies were not kept.

Tags: **[quoted: URL]** = the words in quotation marks are verbatim from that URL. **[inferred]** = my reading of quoted material, not stated by Telnyx. **[unverified]** = not found in Telnyx's docs; do not build on it without a live test.

URL shorthand used in tags (prefix `https://developers.telnyx.com`):

- `FUND` = /docs/voice/programmable-voice/texml-fundamentals.md
- `FETCH` = /docs/voice/programmable-voice/texml-instruction-fetching.md
- `SETUP` = /docs/voice/programmable-voice/texml-setup.md
- `COMPAT` = /docs/voice/programmable-voice/texml-twiml-compatibility.md
- `VERB/<name>` = /docs/voice/programmable-voice/texml-verbs/<name>.md
- `APPAPI` = /api-reference/texml-applications/creates-a-texml-application.md
- `CB/<name>` = /api-reference/callbacks/<name>.md
- `OAS` = /openapi/source/external/legacy-published/texml/calls.json (the OpenAPI file the callback pages render from)
- `WHF` = /docs/development/api-fundamentals/webhooks/receiving-webhooks.md
- `VWH` = /docs/voice/programmable-voice/voice-api-webhooks.md
- `TTS` = /docs/voice/programmable-voice/tts.md
- `STT` = /docs/voice/programmable-voice/speech-to-text.md
- `UPD` = /api-reference/texml-rest-commands/update-call.md
- `PRICE` = https://telnyx.com/pricing.md

---

## 1. TeXML application setup

**Pointing a number at an application**

- "On inbound calls (PSTN or External SIP to Telnyx), Telnyx fetches TeXML instructions from the URL defined on the TeXML Application associated with the SIP subdomain or phone number." [quoted: FETCH]
- "An instance of TeXML application can have a specific SIP subdomain or phone number assigned to it." [quoted: FETCH]
- Portal route: "Assign a number to the TeXML application on the Numbers tab". [quoted: SETUP]
- API route: `PATCH /phone_numbers/{id}` has `connection_id`: "Identifies the connection associated with the phone number." [quoted: /api-reference/phone-number-configurations/update-a-phone-number.md]. That the TeXML application's `id` is the value to put in `connection_id` is **[inferred]** (TeXML webhooks carry `ConnectionId`, "Telnyx connection ID used for the call", and the application `id` example `1293384261075731499` has the same shape). No TeXML page states it.
- "You don't need to issue an answer command, start with Say for text to speech". [quoted: SETUP] So the call is answered by the first verb.

**Application fields (API: `POST /v2/texml_applications`, required `friendly_name`, `voice_url`)** [quoted: APPAPI]

| Field | Documented meaning |
|---|---|
| `voice_url` | "URL to which Telnyx will deliver your XML Translator webhooks." |
| `voice_method` | "HTTP request method Telnyx will use to interact with your XML Translator webhooks. Either 'get' or 'post'." enum `get`, `post`, **default `post`** |
| `voice_fallback_url` | "URL to which Telnyx will deliver your XML Translator webhooks if we get an error response from your voice_url." default null |
| `status_callback` | "URL for Telnyx to send requests to containing information about call progress events." default null |
| `status_callback_method` | enum `get`, `post`, default `post` |
| `first_command_timeout` | "Specifies whether calls to phone numbers associated with this connection should hangup after timing out." default false |
| `first_command_timeout_secs` | "Specifies how many seconds to wait before timing out a dial command." default 30 |
| `anchorsite_override` | `Latency` (default) or a named site (Chicago, Ashburn, San Jose, Sydney, Amsterdam, London, Toronto, Vancouver, Frankfurt) |
| `inbound.channel_limit` | "limit the total number of inbound calls to phone numbers associated with this connection" |
| `call_cost_in_webhooks`, `dtmf_type`, `tags`, `active`, `inbound.sip_subdomain`, `outbound.*` | as named |

Portal names for the same things: "Voice method", "Webhook URL", "Webhook Failover URL" ("A backup URL that Telnyx will use if the primary webhook URL fails to respond"), "Call progress events URL" ("URL where Telnyx will send event callbacks related to your calls"), "Status Callback Method", "Hang-up on timeout" ("Specifies the number of seconds Telnyx will wait for initial application response before hanging up"). [quoted: FUND]

There is **no** webhook-timeout or retry-delay field on a TeXML application (the Voice API application has `webhook_timeout_secs`; the TeXML schema does not). [inferred from APPAPI schema, which lists every property]

**Status callback: events and a completed callback**

- Yes, there is a completed callback. `<Hangup>`: "When the call ends, a callback is sent to the webhook URL defined on the connection level with `CallStatus` set to `completed`." [quoted: VERB/hangup]
- Events documented as TeXML callbacks: initiated, ringing, answered, completed, plus amd and dtmf. [quoted: OAS webhooks `TexmlCallInitiatedWebhook`, `TexmlCallRingingWebhook`, `TexmlCallAnsweredWebhook`, `TexmlCallCompletedWebhook`, `TexmlCallAmdWebhook`, `TexmlCallDtmfWebhook`]
- Which of these an **inbound** call sends to the application-level `status_callback` is not listed. The only statement: "Inbound Status Callback events can be configured for TeXML the connection settings in the Mission Control Portal." [quoted: VERB/dial, `statusCallback` row]. The `statusCallbackEvent` list (`initiated`, `ringing`, `answered`, `amd`, `dtmf`, `completed`, default `completed`) is documented only for `<Number>`/`<Sip>` outbound legs. [quoted: VERB/dial]
- Completed payload (form-encoded). Required: `AccountSid`, `CallInitiatedAt`, `CallSid`, `CallSidLegacy`, `CallStatus`, `From`, `To`, `ConnectionId`, `Timestamp`, `CallbackSource`, `SequenceNumber`. `CallStatus` enum: `completed`, `busy`, `no-answer`, `canceled`, `failed`. Conditional: `CallControlId`, `CallLegId`, `CallSessionId`, `CallDuration`, `StartTime`, `AnsweredTime`, `EndTime`, `HangupCause`, `HangupSource` (example `caller`), `SipHangupCause`, `OccurredAt`, `ErrorCode`, `ErrorMessage`, `RecordingUrl`, `Dial*` fields. `CallbackSource` enum: `call-progress-events`. [quoted: OAS `TexmlCallCompletedWebhookSchema`; page CB/texml-call-completed]
- State cleanup can therefore key on `CallSid` + `CallStatus` in the status callback. [inferred]

**Account-level limits that affect a test setup**

- Pre-trial accounts: "Limited to **1 TeXML Application** at any one time." [quoted: /docs/account-setup/levels-and-capabilities/pretrial.md, read through /public/llms/development-full.txt]
- Pre-trial and trial accounts: "**Inbound** limited to receiving from the verified phone number.", "Limited to a maximum of **10 minutes per call**." [quoted: /docs/account-setup/levels-and-capabilities/pretrial.md and /trial.md, read through /public/llms/development-full.txt]
- L1-verified accounts: "All machine-generated speak commands are pre-pended with \"This is an automated call generated on the Telnyx platform, please report any abuse to fraud@telnyx.com\"" and the list includes "the TeXML verbs: Play, Say". [quoted: /docs/voice/programmable-voice/l1-accounts-restirctions.md]. The paid-level page repeats the same list. [quoted: /docs/account-setup/levels-and-capabilities/paid.md via development-full.txt]

---

## 2. Webhook request format, timeouts, retries

**Method and encoding**

- "Method: Configurable (GET or POST, default is GET)". [quoted: FETCH] (The API reference says default `post`; see Contradictions.)
- "GET requests - as URL query parameters", "POST requests - in the request body as form-encoded data". [quoted: FETCH]
- All TeXML callbacks are declared `application/x-www-form-urlencoded`. [quoted: OAS; also https://developers.telnyx.com/data/webhook-events.json `media_type`]
- "The envelope is not universal. TeXML callbacks can be form-encoded". [quoted: WHF] TeXML requests do **not** use the JSON `data`/`meta` envelope, so there is no `data.id` and no `meta.attempt`. [inferred from OAS schemas]
- `<Gather action>`: "Same method (`GET`/`POST`) as set for the TexML application is used." [quoted: VERB/gather]

**Fields on the instruction fetch (voice URL)** "the following parameters are always included" [quoted: FETCH]

| Parameter | Description (verbatim) | Example |
|---|---|---|
| `AccountSid` | The user's Telnyx account ID | 6a9a7976-012e-45d2-9258-6f5dc68d861e |
| `CallSid` | Unique identifier for the call | fcc47bc6-e428-11ed-ad79-02420aef00b4 |
| `CallSidLegacy` | Legacy call ID format for backward compatibility | (same value) |
| `CallerId` | The identifier of the caller | +13122010091 |
| `CallingPartyType` | The type of calling party. Possible values: sip or pstn | sip |
| `From` | The phone number that initiated the call | +13122010091 |
| `FromSipUri` | Sip Uri address of the caller | |
| `To` | The phone number that received the call | +13122010090 |
| `ToSipUri` | Sip Uri address that received the call | |
| `ConnectionId` | Telnyx connection ID used for the call | 1568109700606592442 |

The page's own example request also carries `CallStatus=in-progress`, which is not in the table. [quoted: FETCH]

**Call identifiers**

- `CallSid`: "The unique identifier of the call (call_control_id)." `CallSidLegacy`: "Legacy call identifier, same as CallSid." [quoted: OAS]
- Callback examples show `CallSid` as `v3:9X2vxPDFY2RHSJ1EdMS0RHRksMTg7ldNxdjWbVr9zBjbGjGsSe-aiQ` (and `v2:...` in the Gather example). [quoted: OAS examples]
- `CallControlId`, `CallLegId`, `CallSessionId` appear only on the completed callback ("only present when CallStatus is 'completed'"). [quoted: OAS]
- `ParentCallSid` appears on legs created by `<Dial>`. [quoted: OAS]

**Stable across retries of the same webhook**

- Nothing is documented. TeXML payloads have no event id or attempt counter. Status callbacks carry `SequenceNumber` ("The sequence number of the event.") and `Timestamp`; the Gather action payload carries neither. [quoted: OAS schemas]
- So a repeated Gather action POST is indistinguishable from the first by any Telnyx field. An adapter that needs an idempotent turn id must put its own counter in the `action` URL. [inferred] Whether Telnyx preserves a query string on an `action` URL is not stated; the dynamic-parameter guide passes query parameters on the voice `Url`. [quoted for `Url`: /docs/voice/programmable-voice/texml-interpreter.md; action URL: unverified]

**Response the application must send**

- "Be valid XML with a root `<Response>` element", "Not exceed size limits", "Return HTTP status code 200 OK". [quoted: FETCH] The size limit is not given anywhere. [unverified]
- Callbacks: "The server must return an HTTP 200, otherwise we will reattempt delivery at the failover webhook URL." [quoted: OAS, every TeXML webhook `responses.200`]

**Timeout and retry rules: not published for TeXML**

- The TeXML pages give no number for how long Telnyx waits for the voice URL or an `action` URL. The only guidance: "Keep response times low to avoid call delays". [quoted: FETCH]
- The generic page refuses to give one: "Product-specific policies determine retry timing, timeout, and failover destinations. Do not implement one assumed schedule for every Telnyx webhook." [quoted: WHF]
- Failover is the only documented recovery: fallback URL is used "if we get an error response from your voice_url" [quoted: APPAPI] / "if the primary webhook URL fails to respond" [quoted: FUND].
- "Hang-up on timeout": "Specifies the number of seconds Telnyx will wait for initial application response before hanging up" [quoted: FUND]; API `first_command_timeout_secs` default 30, described as "how many seconds to wait before timing out a dial command" [quoted: APPAPI]. Whether this bounds the HTTP wait on the first fetch is **[unverified]**.
- Neighbouring products, for scale only (not TeXML): Voice API `webhook_timeout_secs` "Seconds to wait before timing out (0–30, default: null)", and response-code table "408, 429 ... Retried", "Other 4xx ... Not retried", "5xx ... Retried", "3xx ... Followed (up to 3 redirects)" [quoted: VWH]; Messaging: "Return a `2xx` status code within **2 seconds**" and "retries (up to 3 attempts per URL)" [quoted: /docs/messaging/messages/receiving-webhooks.md].
- **Whether a 2 to 5 second reply is safe is [unverified].** It must be measured on a live call.

**Documented way to decouple a slow reply from the HTTP response** [endpoint quoted; the pattern is inferred]

- `POST /v2/texml/Accounts/{account_sid}/Calls/{call_sid}`, "Update TeXML call. Please note that the keys present in the payload MUST BE formatted in CamelCase". Body fields: `Texml` ("TeXML to replace the current one with."), `Url` ("The URL where TeXML will make a request to retrieve a new set of TeXML instructions to continue the call flow."), `Method`, `FallbackUrl`, `FallbackMethod`, `StatusCallback`, `StatusCallbackMethod`, `Status` ("Setting the status to completed ends the call."). [quoted: UPD and OAS `UpdateCallRequest`]
- `account_sid` is "a Telnyx account UUID, not a Twilio `AC...` SID". [quoted: UPD]
- An adapter could answer the action POST at once with `<Pause>`/`<Redirect>` and push the real reply with `Texml` when it is ready. [inferred; untested]

---

## 3. Webhook authenticity

- TeXML callbacks declare two **required** headers: `telnyx-timestamp` ("Unix timestamp (seconds since epoch) of when the webhook was sent") and `telnyx-signature-ed25519` ("Base64 encoded Ed25519 signature for webhook verification"; schema description "Ed25519 signature of timestamp|payload for verification"). This is on the Gather action webhook as well as the status callbacks. [quoted: OAS `TexmlGatherWebhook`, `TexmlCallCompletedWebhook`, etc.; rendered at CB/texml-gather]
- Page text: "This webhook uses Telnyx headers (telnyx-timestamp, telnyx-signature-ed25519) that are compatible with Standard Webhooks specification for SDK generation." [quoted: CB/texml-gather]
- What is signed: `timestamp|payload` [quoted: OAS]. The Messaging page spells the same scheme out: "The signature is computed over the string `{timestamp}|{json_payload}`." [quoted: /docs/messaging/messages/receiving-webhooks.md]. For a form-encoded TeXML POST the payload is presumably the raw form body. [inferred] For a `GET` (no body) it is not documented. [unverified]
- "Verification requires the exact body bytes received by the server. Do not parse and reserialize JSON before verification." [quoted: WHF]
- Public key: "Products that document Telnyx Ed25519 signing use the account's key pair. The public key is available in [Mission Control Portal](https://portal.telnyx.com/#/api-keys/public-key)." [quoted: WHF]. One key pair per account, the same one used for media-stream WebSocket signing ("the same one Telnyx uses to sign webhooks"). [quoted: /docs/voice/programmable-voice/media-streaming.md]
- Replay window: "reject signatures outside the application's replay window" (no number) [quoted: WHF]; Messaging page: "reject webhooks where `telnyx-timestamp` is more than 5 minutes old." [quoted: /docs/messaging/messages/receiving-webhooks.md]
- SDK: "Telnyx signs every webhook delivery with an ED25519 signature carried in the `telnyx-signature-ed25519` and `telnyx-timestamp` request headers." Helper: `client.webhooks.unwrap(req.body, { headers })`, reads `TELNYX_PUBLIC_KEY`. The only example is for `application/json` and returns "the parsed event" with `event.data?.event_type`. [quoted: /docs/development/sdk/node/webhooks.md] Whether `unwrap()` accepts a form-encoded TeXML body is **[unverified]**; verifying Ed25519 directly over `${timestamp}|${rawBody}` avoids the question. [inferred]
- **Gap:** the instruction-fetch page (the first request to `voice_url`) never mentions a signature. Its only security line is "Always verify the CallSid parameter to ensure the request is legitimate". [quoted: FETCH] Whether the initial fetch carries the two headers is **[unverified]**.
- WebSocket streams are signed differently: "The signature covers the string `{telnyx-timestamp}|{stream_url}`". [quoted: /docs/voice/programmable-voice/media-streaming.md]

---

## 4. `<Gather>` with speech input

Page summary still says: "The `<Gather>` verb collects DTMF tones during a call. `<Say>` can be nested within `<Gather>` to create an interactive IVR with text-to-speech." [quoted: VERB/gather] Speech is documented only through the attribute table.

**Attributes** [all quoted: VERB/gather]

| Attribute | Description (verbatim) | Options | Default |
|---|---|---|---|
| `action` | "URL where TeXML will send the gathered result and message history. Same method (`GET`/`POST`) as set for the TexML application is used. Transfers control of the current call to the TeXML file returned." | | - |
| `timeout` | "Time in seconds between digits before the `<Gather>` digits are sent to your action URL. Telnyx will wait until all nested verbs have been executed before beginning the timeout period." | 1 - 120 | 5 |
| `input` | "The input type for the gather action." | `dtmf`, `speech`, `dtmf speech` | `dtmf` |
| `speechTimeout` | "Time in seconds to wait after speech ends before timing out." | none listed | - |
| `partialResultCallback` | "URL for sending partial gather results." | | - |
| `partialResultCallbackMethod` | | `GET`, `POST` | `POST` |
| `profanityFilter` | "Whether to filter profanity from speech recognition results (camelCase format)." | | - |
| `useEnhanced` | "Enables enhanced transcription, this works for models phone_call and video (camelCase format)." | | - |
| `hints` | "Hints to improve transcription accuracy. On Deepgram, this maps to the Nova-2 keyword biasing feature and is supported only on Nova-2 models ...; it is silently dropped on Nova-3 and Flux models (use `keyterms` instead). Accepts a comma-separated string." | | - |
| `keyterms` | "Deepgram keyterm prompting. ... Supported only on Nova-3 and Flux models ...; silently dropped on Nova-2 models (use `hints` instead). Accepts a comma-separated string." | | - |
| `smartFormat` | "Disable Deepgram's smart formatting so the transcript stays lowercase with no punctuation. Deepgram-only; silently dropped on other engines." | | `true` |
| `transcriptionEngine` | "Engine to use for speech recognition: Google, Telnyx, Azure, Deepgram, xAI, AssemblyAI, Soniox, Speechmatics, Parakeet, Humain, Reson8, Cohere, or the registered name of a community engine ..." | | - |
| `model` | "Speech recognition model. Format is `vendor/model-name` — e.g. `deepgram/nova-2`, `deepgram/nova-3`, `azure/fast`, `assemblyai/universal-streaming`, `soniox/stt-rt-v4`, `speechmatics/standard`, ... `deepgram/flux` / `deepgram/flux-multi`. The vendor must match `transcriptionEngine`. On Deepgram, defaults to `deepgram/nova-3` when unset." | | - |
| `apiKeyRef` | "Reference to the API key for authentication. ... Used with Azure transcriptionEngine. Required with a community engine" | | - |
| `region` | "Region to use with the specified transcription engine. Required for Azure." | | - |
| `finishOnKey` | "The set of digits, (0-9, *, #), that indicates the end of the gather." | | `#` |
| `numDigits` | "The number of digits to be gathered." | | - |
| `language` | "Language for speech recognition, as a BCP-47 tag such as `en-US` or `fr-CA`. ... otherwise it is reduced to its base language (`fr-FR` becomes `fr`), and unrecognized values fall back to `en`." | | `en-US` |
| `validDigits`, `invalidDigitsAction`, `minDigits` (1-128, default 1), `maxDigits` (1-128, default 128) | DTMF only | | |

Child verbs: `Say`, `Play`. [quoted: VERB/gather]

**Asked about, and absent from the Telnyx page** (do not assume the Twilio behaviour): `method` on `<Gather>`, `speechModel` (the attribute is `model`; `speechModel` exists only on `<ConversationRelay>`), `bargeIn` / `interruptible`, `actionOnEmptyResult`, `enhanced`, `speechTimeout="auto"`. [inferred from the complete attribute table]

- `speechTimeout` unit is seconds; no allowed range, no default and no `auto` value are documented. [quoted for unit: VERB/gather; `auto`: unverified]
- Default `transcriptionEngine` for `<Gather>` is not stated (`<Transcription>` defaults to `Google`). [quoted for Transcription: VERB/transcription; Gather default: unverified]

**Fields posted to `action`** [quoted: OAS `TexmlGatherWebhookSchema`]

| Field | Description (verbatim) |
|---|---|
| `AccountSid` (required) | "The unique identifier of the account (user_id)." |
| `CallSid` (required) | "The unique identifier of the call (call_control_id)." |
| `CallSidLegacy` (required) | "Legacy call identifier, same as CallSid." |
| `From` (required) | "The phone number or SIP address of the caller." |
| `To` (required) | "The phone number or SIP address that was called." |
| `SpeechResult` | "The transcribed text from speech input (conditional, only present when input is speech)." |
| `Confidence` | number, "The average confidence score of the speech transcription (conditional, only present when input is speech)." |
| `Digits` | "The DTMF digits collected by the Gather command (conditional, only present when input is dtmf)." |

Example: `Confidence: 0.95`, `Digits: "1"`, `SpeechResult: "Please connect me to sales"`. [quoted: OAS]. Note the action description says it sends "the gathered result and message history", but no message-history field is in the schema.

**No input**

- Not documented. The page does not say whether a timed-out Gather posts to `action` with an empty `SpeechResult`, skips `action` and falls through to the next verb (TwiML behaviour), or hangs up. [unverified] An adapter should put an explicit verb after `</Gather>` (for example `<Redirect>` to a "still there?" document) and also tolerate an action POST with no `SpeechResult`. [inferred]
- The `partialResultCallback` payload is not documented. [unverified]

**Barge-in**

- Not documented for `<Gather>`. The only related sentence: "Telnyx will wait until all nested verbs have been executed before beginning the timeout period." [quoted: VERB/gather]. Whether caller speech stops a nested `<Say>` is **[unverified]**. Interruption control exists as documented attributes only on `<ConversationRelay>` (`interruptible`: `none`, `any`, `speech`, `dtmf`) and `<AIGather>` (`<InterruptionSettings enable="true"/>`). [quoted: VERB/conversationrelay, VERB/aigather]

**Engines** (same list for `<Gather>` and `<Transcription>`): Google, Telnyx, Deepgram (nova-2, nova-3, flux), Azure, xAI, AssemblyAI, Soniox, Speechmatics, Parakeet, Humain, Reson8, Cohere, community engines. "Telnyx - In-house Telnyx speech-to-text engine with significantly better transcription accuracy and lower latency." [quoted: STT]

**`<Transcription>` as the other route to speech**

- "The `<Transcription>` verb enables real-time speech-to-text transcription for the call." Used inside `<Start>` (asynchronous: "As soon as the service is started, the next TeXML instructions will be executed"). [quoted: VERB/transcription, VERB/start]
- Attributes: `language` (default `en`), `interimResults` (default false, "Applies to transcriptionEngine A only"), `transcriptionEngine` (default `Google`; legacy `A` = Google, `B` = Telnyx), `transcriptionTracks` (`inbound`, `outbound`, `both`), `transcriptionCallback`, `transcriptionCallbackMethod` (default `POST`), `model`, `hints`, `keyterms`, `smartFormat`, `apiKeyRef`, `region`. [quoted: VERB/transcription]
- Callback fields shown in the guide: `AccountSid`, `CallSid`, `CallSidLegacy`, `Confidence`, `ConnectionId`, `From`, `IsFinal`, `To`, `Transcript`. [quoted: STT]
- It gives a stream of transcripts with no end-of-turn decision and no way to return TeXML in the response, so the application would have to decide turn ends itself and drive the call through the Update-call REST endpoint. [inferred]

---

## 5. `<Say>`

**Attributes** [quoted: VERB/say]

- `voice`, default `man`: "For basic text-to-speech use `man` or `woman` (en-US only). For premium text-to-speech use `alice` or one of the following provider-prefixed formats: `Polly.VoiceId` / `Polly.VoiceId-Neural` for Amazon Polly, `AWS.Polly.VoiceId` for direct AWS Polly notation, `Azure.VoiceId` for Azure TTS (supports `gender` and `effect` attributes), `ElevenLabs.ModelId.VoiceId` for ElevenLabs (requires `api_key_ref`), `Telnyx.ModelId.VoiceId` for Telnyx native TTS, `Resemble.ModelId.VoiceId` for Resemble AI, `Minimax.ModelId.VoiceId` for Minimax, `Rime.ModelId.VoiceId` for Rime, `Inworld.ModelId.VoiceId` for Inworld, and `FishAudio.ModelId.VoiceId` for Fish Audio".
- `language`: "ISO language type to be used if voice type alice is selected. If man or woman is selected, the language accent will always be en-US. This parameter is ignored when a specific Amazon Polly voice is used."
- `loop` 0-10, default 1 ("0 means infinite").
- `voiceSpeed` 0.1-2.0, default 1.
- `api_key_ref`: "Reference to the API key for authentication with the TTS provider. The key must be stored via the integration secrets API. Used with ElevenLabs, Azure and Rime voices." (snake_case, unlike Gather's `apiKeyRef`.)
- `region` ("Required for Azure voices when using a custom API key"), `gender` and `effect` (Azure only), `pronunciationDictId`, `languageBoost` (Telnyx Qwen3TTS).

**Voice families and naming, with the examples Telnyx gives** [quoted: TTS unless noted]

| Family | Example value |
|---|---|
| Basic | `man`, `woman` [VERB/say] |
| `alice` | "premium Amazon Polly text-to-speech" in the page example [VERB/say] |
| Telnyx Kokoro | `Telnyx.KokoroTTS.af` |
| Telnyx Ultra | `Telnyx.Ultra.3e1ed423-17e5-4773-b87c-25b031106e41`; also `Telnyx.Ultra.Clara` [/docs/voice/tts/in-call-playback.md] |
| Telnyx Natural / NaturalHD | `Telnyx.Natural.abbie`, `Telnyx.NaturalHD.astra` [VERB/conversationrelay] |
| AWS Polly | `Polly.Brian`, `Polly.Amy-Neural` ("The neural voice can be used by adding the prefix to the voice name - `Polly.*-Neural`") |
| Azure | `Azure.en-CA-ClaraNeural`; HD example `en-US-Emma:DragonHDLatestNeural` |
| ElevenLabs | `ElevenLabs.Default.cgSgspJ2msm6clMCkdW9` with `api_key_ref="your_api_key_ref"` |
| MiniMax | `Minimax.speech-2.6-turbo.English_expressive_narrator` |
| Resemble | `Resemble.Pro.Aaron_en-US` |
| Inworld | `Inworld.Mini.Loretta` |
| Soniox | `Soniox.tts-rt-v2.Emma` with `language="en"` |

- Full voice list: `GET https://api.telnyx.com/v2/text-to-speech/voices`. [quoted: /docs/voice/tts/available-voices.md]
- General scheme: "In-call TTS uses the same voice format as WebSocket and REST: `Provider.Model.VoiceId`" and "All models (including Ultra) are available for in-call playback." [quoted: /docs/voice/tts/in-call-playback.md]

**ElevenLabs requirements** [quoted: TTS]

- "To use the integration, you must provide an API key to your ElevenLabs account." Stored with `POST https://api.telnyx.com/v2/integration_secrets` body `{"identifier":"your_api_key_ref","value":"api_key"}`; the `identifier` is what `api_key_ref` names.
- "*Please note: only a premium ElevenLabs can be used for the integration. The freemium account is not supported*"
- "response latency may exceed what you'd see from AWS Polly or Azure AI Speech."
- "`voice_id` is a voice from **your own ElevenLabs account**". [quoted: /docs/voice/tts/providers/elevenlabs.md]
- Billing: "ElevenLabs | BYO API key (billed by ElevenLabs)". [quoted: PRICE]
- The create-secret reference shows a different body shape (`identifier`, `type: bearer`, `token`). [quoted: /api-reference/integration-secrets/create-a-secret.md] See Contradictions.

**SSML**

- The `<Say>` page does not mention SSML, and gives no attribute to mark the body as SSML. [inferred from VERB/say]
- Elsewhere: Azure neural voices "offer high-quality output with support for SSML" [quoted: TTS]; "SSML is supported by AWS Polly and Azure" (REST TTS `text_type`) [quoted: /docs/voice/tts/rest-api/request.md via voice-full.txt]; "SSML payloads are rejected for Soniox voices" [quoted: TTS]; the Polly SSML tutorial is written for the Voice API `speak` command [quoted: /docs/voice/tts/providers/aws/ssml-tags.md].
- Whether `<speak>` markup inside a TeXML `<Say>` body is honoured is **[unverified]**.

**Max text length**

- Not documented for `<Say>`. [unverified] The Voice API `speak` command says: "The text or SSML to be converted into speech. There is a 3,000 character limit." [quoted: /api-reference/call-commands/speak-text.md]. That `<Say>` shares it is **[inferred]**.

**`<Say>` nested in `<Gather>`: interruptible by speech?** Not documented. [unverified] See section 4, Barge-in.

**XML escaping:** not discussed by Telnyx; the reply text is XML character data, so `&`, `<`, `>` must be escaped by the adapter. [inferred]

---

## 6. `<Hangup>`, `<Redirect>`, `<Pause>`, `<Dial>`

- **`<Hangup/>`**: "Ends the call". No attributes. Closing a call is `<Say>...</Say><Hangup/>`; the quickstart: "you want to hangup the call otherwise there will be silence". [quoted: VERB/hangup, SETUP]
- **`<Reject reason="rejected|busy"/>`**: "If placed as the very first verb in an incoming call, `<Reject>` will prevent the call from being answered and will incur no cost." [quoted: VERB/reject]
- **`<Redirect method="POST">URL</Redirect>`**: "transfers control of a call to the TeXML document to another TeXML application." `method`: `GET`, `POST`, default `POST`. "No nouns can be nested within `<Redirect>`". [quoted: VERB/redirect]
- **`<Pause length="5"/>`**: "waits silently for a specified number of seconds or one second by default." `length` 1-180, default 1. "a self-closing tag must be used." [quoted: VERB/pause]
- **`<Dial>`**: "transfers an existing call to another destination. `<Dial>` will end this new call if: the called party does not answer, the number does not exist, or Telnyx receives a busy signal." [quoted: VERB/dial]
  - **Bare number is accepted**: `<Dial action="/nextinstructions.php" callerId="+13120001234">+19999999999</Dial>` [quoted: VERB/dial]; also `<Dial>+15551234567</Dial>` [quoted: VERB/aiassistant].
  - Nouns: `<Number>`, `<Sip>`, `<Queue>` (and `<Conference>`). Several nouns ring at once unless `sequential="true"`. [quoted: VERB/dial]
  - Attributes that matter for a transfer: `action` ("Optional URL where TeXML will make a request when the `<Dial>` call ends to retrieve a new set of TeXML instructions to continue the call flow."), `method` (default `POST`), `callerId` ("must be a valid E.164 format number"), `timeout` 5-120 default 30 (seconds to wait for answer), `timeLimit` 60-14400 default 14400, `answerOnBridge`, `record`, `ringTone`, `hangupOnStar`. [quoted: VERB/dial]
  - The `action` callback uses the call-completed payload with `DialCallStatus` (`completed`, `busy`, `no-answer`, `canceled`, `failed`), `DialCallSid`, `DialCallDuration`. [quoted: VERB/dial, OAS]
  - A transfer to a human therefore looks like: `<Say>` a handover line, then `<Dial callerId="+1..." action="https://app/after-dial" timeout="20">+1...</Dial>`, with the `action` handler returning a fallback when `DialCallStatus` is not `completed`. [inferred]
  - Limit: "Default 30 dials per second limit for the Voice API Dial command and TeXML's `<Dial>` verb". [quoted: /public/llms/calling.txt index entry for dials-per-second-limit]
- **`<Refer>`**: SIP REFER transfer "to another SIP infrastructure"; priced per invocation ("Call Control Features SIP Refer | $0.1 | invocation"). [quoted: VERB/refer summary in calling.txt; PRICE]

---

## 7. TeXML for AI and streaming (names and pointers only)

- **`<Start><Stream>` / `<Connect><Stream>`** (VERB/stream, VERB/connect, VERB/start; guide /docs/voice/programmable-voice/media-streaming.md). "starts streaming the media from a call to a specific WebSocket address in near-real-time. Audio will be delivered as base64-encoded RTP payloads (no headers), wrapped in JSON payloads." Attributes: `url`, `track` (`inbound_track` default, `outbound_track`, `both_tracks`), `codec` (PCMU, PCMA, G722, OPUS, AMR-WB, default), `bidirectionalMode` (`mp3` default, `rtp`), `bidirectionalCodec`, `bidirectionalSamplingRate` (8000, 16000, 24000), `statusCallback`, `enableReconnect` (default true), child `<Parameter>`. Under `<Start>` it runs alongside the remaining verbs; under `<Connect>` it is synchronous. The application does its own STT, TTS and turn-taking. [quoted: VERB/stream]
- **`<Connect><ConversationRelay>`** (VERB/conversationrelay; guide /docs/voice/programmable-voice/conversation-relay.md). "routes a call to a ConversationRelay service that provides voice interactions over a WebSocket connection. It provides speech-to-text transcription and allows requesting text-to-speech synthesis for the call over WebSocket." Telnyx does STT and TTS; the application receives `setup`, `prompt`, `dtmf`, `interrupt`, `error` frames and sends `text`, `play`, `sendDigits`, `language`, `end`. Attributes include `url`, `welcomeGreeting`, `voice`, `language`, `transcriptionProvider`/`transcriptionEngine`, `speechModel`, `interruptible` and `welcomeGreetingInterruptible` (`none`, `any`, `speech`, `dtmf`; default `any`), `dtmfDetection`, `events`, `partialPrompts` (Deepgram Flux only). `<Connect action>` gets control back when the session ends. Priced at $0.05/min ("Call Control Features Conversation Relay - per minute"). [quoted: VERB/conversationrelay, conversation-relay guide, PRICE]
- **`<Connect><AIAssistant id="assistant-...">`** (VERB/aiassistant). "allows you to start a voice assistant on the call." The assistant (prompt, model, voice, tools) is a Telnyx-hosted AI Assistant created through the Assistants API, so the model call is made by Telnyx, not the application. `<Connect action>` is requested when the conversation ends, with a `Reason` field (`service_error`, `stt_error`, `handoff`, `hangup`; `normal` means a transfer is in progress and the action is not requested). `join` adds the leg to an existing conversation. [quoted: VERB/aiassistant, VERB/connect]
- **`<AIGather>`** (VERB/aigather; guide /docs/voice/programmable-voice/gather-using-ai.md). "collects specific information from call participants leveraging AI. It requires the child node `<Parameters>` to be provided with a JSON Schema object". Children: `<Greeting>`, `<Voice>`, `<Parameters>`, `<MessageHistory>`, `<Tools>`; the example also shows `<InterruptionSettings>`, `<Transcription>`, `<Assistant model=... instructions=...>`. A Telnyx-run LLM conducts the exchange; the `action` callback returns `Base64Result`, `Base64MessageHistory`, `Status`. [quoted: VERB/aigather, OAS `TexmlAiGatherWebhook` example]
- **`<Start><Transcription>`**: see section 4.
- Related REST: "Initiate an outbound AI call" (`POST /texml/ai_calls/{connection_id}`) and `GET /ai/assistants/{assistant_id}/texml`. [quoted: /public/llms/calling/texml.txt and development-full.txt SDK tables]
- There is no `<Connect><Assistant>` noun in Telnyx's docs; the noun is `<AIAssistant>`. TwiML's `<VirtualAgent>` is listed as "Not supported". [quoted: COMPAT, VERB/connect]

---

## 8. Latency guidance and pricing

**Latency**

- No latency figures or tuning guidance for a Gather-based speech loop are published. [inferred from a keyword search of /public/llms/calling-full.txt, /public/llms/calling/texml-full.txt and /public/llms/voice-full.txt]
- The only statements found: "Keep response times low to avoid call delays" [quoted: FETCH]; AnchorSite `Latency` "directs Telnyx to route media through the site with the lowest round-trip time to the user's connection" [quoted: APPAPI]; ElevenLabs "response latency may exceed what you'd see from AWS Polly or Azure AI Speech" [quoted: TTS]; Telnyx STT "significantly better transcription accuracy and lower latency" [quoted: STT]; Telnyx Ultra "Sub-100ms latency across 44 languages" [quoted: /docs/voice/tts/available-voices.md].
- The per-turn delay of a Gather loop is at least `speechTimeout` + STT finalisation + the action round trip + application compute + TTS start. [inferred] Telnyx's lower-latency constructs (partial prompts, eager end of turn, streaming TTS) are documented only for `<ConversationRelay>`. [quoted: VERB/conversationrelay]

**Pricing (USD, pay-as-you-go, as published on the fetch date)**

- TeXML minutes: "If you're using TeXML, you'll be charged the same $0.002 fee." and "$0.002 per minute + the SIP Trunking fee for inbound calls" (local and toll-free). [quoted through the WebFetch summariser: https://telnyx.com/pricing/call-control]
- "Voice Api Inbound Local Usd Per Min | $0.002/min | flat | Platform fee for local numbers; SIP trunking fees apply on top"; "Sip Inbound Usd Per Min | From $0.0032/min". [quoted: PRICE] So an inbound local minute starts at about $0.0052 before speech. [inferred]
- Speech-to-text per minute [quoted: PRICE summary table]: Telnyx $0.015, Deepgram Nova 2 / Nova 3 / Flux $0.0074, Google $0.017, Azure $0.027, AssemblyAI $0.007, Grok (xAI) $0.0033, Parakeet $0.0015, Soniox $0.002, Speechmatics $0.0035, Humain $0.007, Cohere Arabic $0.0015.
- Text-to-speech per character [quoted: PRICE summary table]: Telnyx $0.000006, Amazon Polly Standard $0.000009, Polly Neural $0.000024, Telnyx HD Voices $0.000048, Telnyx Ultra $0.000032, Qwen3TTS $0.000032, MiniMax $0.000034, Rime $0.000020, Inworld Mini $0.0000055, Inworld Max $0.000010, Resemble $0.000008, Murf $0.000008, Azure Neural HD $0.000050, ElevenLabs "BYO API key (billed by ElevenLabs)".
- Other: media streaming over WebSocket $0.0035/min; Conversation Relay and Voice AI Assistant $0.05/min; call recording $0.002/min; SIP Refer $0.1 per invocation. [quoted: PRICE]
- Whether STT inside `<Gather>` is billed for the whole Gather window or only for detected speech is not stated. [unverified]

---

## Contradictions and gaps in the docs

**Contradictions**

1. **Default voice method.** FETCH: "Method: Configurable (GET or POST, default is GET)". APPAPI: `voice_method` `default: post`. Set it explicitly.
2. **`CallSid` format.** FETCH example: `fcc47bc6-e428-11ed-ad79-02420aef00b4` (UUID). OAS examples: `v3:9X2vxPDFY2RHSJ1EdMS0RHRksMTg7ldNxdjWbVr9zBjbGjGsSe-aiQ` and `v2:...`, described as "(call_control_id)". Treat it as an opaque string, and URL-encode it (it contains `:`) when used in the Update-call path. [last clause inferred]
3. **Is signing universal?** SDK page: "Telnyx signs every webhook delivery". WHF: "When the selected product documents Ed25519 signing ... Follow another signing or validation scheme when the selected product defines one." TeXML documents the headers only in the callback OpenAPI, never on the instruction-fetch page.
4. **STT and TTS prices differ between Telnyx's own pages.** Deepgram STT: $0.0074/min (PRICE summary) vs $0.005 (PRICE live rate sheet "Call Control Features Deepgram Speech-To-Text", and telnyx.com/pricing/call-control). AssemblyAI: $0.007 vs $0.005. Telnyx TTS: $0.000006/char (PRICE summary) vs $0.000003 (telnyx.com/pricing/call-control, and PRICE live sheet "In-House Text-To-Speech"). Azure Neural HD: $0.000050 vs "BYO API key (billed by Azure)" vs $0.000024 in the live sheet.
5. **`first_command_timeout_secs`.** Portal wording: "wait for initial application response before hanging up". API wording: "wait before timing out a dial command".
6. **Gather `action` method.** Gather says the application's method is used and lists no `method` attribute. `<AIGather>` says the same sentence and also lists a `method` attribute (default `POST`). `<Dial>`, `<Connect>`, `<Redirect>` have their own `method` defaulting to `POST`.
7. **Attribute casing.** `<Say api_key_ref>` (snake_case) vs `<Gather apiKeyRef>` / `<Transcription apiKeyRef>` (camelCase).
8. **ElevenLabs voice format and secret store.** `ElevenLabs.ModelId.VoiceId` (VERB/say), `ElevenLabs.Default.<id>` (TTS example), `elevenlabs.<Model>.<VoiceId>` lowercase (provider page). Secret: TTS guide posts `{identifier, value}` to `/v2/integration_secrets`; the reference documents `{identifier, type, token}`; `<AIGather>` says the key "must be added to the account text-to-speech secrets /v2/text-to-speech/secret".
9. **Telnyx Ultra availability.** available-voices: "REST API only". in-call-playback: "All models (including Ultra) are available for in-call playback", with a `<Say voice="Telnyx.Ultra.Clara">` example.
10. **`<Pay>`.** COMPAT table: "❌ Not supported" for TeXML. A full `<Pay>` verb page exists.
11. **`<Gather>` description** says it "collects DTMF tones" while the attribute table documents speech.
12. **Transcription callback reference.** CB/texml-transcription is described as "Webhook sent when a recording transcription is completed", not the real-time `<Transcription>` callback; the real-time payload appears only in the STT guide.
13. **Gather `action`** is said to receive "the gathered result and message history"; the payload schema has no message-history field.
14. **Instruction-fetch parameters.** "always included" table omits `CallStatus`, which the example on the same page sends.

**Gaps (the docs are silent)**

1. How long Telnyx waits for a TeXML HTTP response (voice URL and `action`), and what the caller hears meanwhile.
2. Whether TeXML requests are retried at all, how many times, and after which status codes; whether the fallback URL also serves `action` requests.
3. Any idempotency or attempt marker on TeXML requests.
4. Whether the first `voice_url` fetch is signed; what is signed for a `GET`.
5. `<Gather>` on no input (action called or fall-through), and on caller hangup mid-Gather.
6. `<Gather>` barge-in over nested `<Say>`/`<Play>`.
7. `speechTimeout` range, default and `auto`; default `transcriptionEngine` for Gather; `partialResultCallback` payload.
8. No worked example anywhere of `<Gather input="speech">`.
9. `<Say>` maximum length and SSML handling.
10. The "size limits" on a TeXML response.
11. Which status-callback events an inbound call emits to the application-level `status_callback`.
12. That a TeXML application id is the `connection_id` to set on a phone number.
13. Latency expectations for a Gather loop; STT billing basis inside Gather.

---

## URLs fetched

All under `https://developers.telnyx.com` unless shown otherwise. "raw" = fetched as markdown/JSON with curl and read directly. "summariser" = fetched with WebFetch, whose small model paraphrases, so quotes from those are second-hand.

| URL | Loaded | How |
|---|---|---|
| /llms.txt | yes | raw |
| /public/llms/calling/texml.txt | yes | raw + summariser |
| /public/llms/calling/texml-full.txt | yes | raw (keyword search) |
| /public/llms/calling.txt | yes | raw |
| /public/llms/calling-full.txt | yes | raw (keyword search) |
| /public/llms/voice-full.txt | yes | raw (keyword search, TTS/STT sections read) |
| /public/llms/development-full.txt | yes | raw (keyword search, account levels and SDK webhook sections read) |
| /docs/voice/programmable-voice/texml-fundamentals.md | yes | raw |
| /docs/voice/programmable-voice/texml-instruction-fetching.md | yes | raw |
| /docs/voice/programmable-voice/texml-interpreter.md | yes | raw |
| /docs/voice/programmable-voice/texml-twiml-compatibility.md | yes | raw |
| /docs/voice/programmable-voice/texml-setup.md | yes | raw |
| /docs/voice/programmable-voice/texml-sending-http-requests.md | yes | raw (keyword search only) |
| /docs/voice/programmable-voice/texml-bin-dynamic.md | yes | raw (keyword search only) |
| /docs/voice/programmable-voice/texml-verbs/gather.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/say.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/hangup.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/redirect.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/pause.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/dial.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/connect.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/start.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/stream.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/conversationrelay.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/aiassistant.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/aigather.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/transcription.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/play.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/reject.md | yes | raw |
| /docs/voice/programmable-voice/texml-verbs/refer.md | yes | raw (not read in full) |
| /docs/voice/programmable-voice/texml-verbs/httprequest.md | yes | raw (keyword search only) |
| /docs/voice/texml/rest-api/applications.md | yes | raw |
| /docs/voice/texml/rest-api/secrets.md | yes | raw |
| /api-reference/texml-applications/creates-a-texml-application.md | yes | raw |
| /api-reference/texml-rest-commands/update-call.md | yes | raw |
| /api-reference/callbacks/texml-gather.md | yes | raw (page has no schema; schema read from OAS) |
| /api-reference/callbacks/texml-call-completed.md | yes | raw (same) |
| /api-reference/callbacks/texml-call-initiated.md | yes | raw (same) |
| /api-reference/callbacks/texml-call-answered.md | yes | raw (same) |
| /api-reference/callbacks/texml-transcription.md | yes | raw (same) |
| /api-reference/callbacks/texml-stream.md | yes | raw (not read in full) |
| /openapi/source/external/legacy-published/texml/calls.json | yes | raw |
| /openapi/source/external/legacy-published/texml/applications.json | **no, 404** | guessed path |
| /data/webhook-events.json | yes | raw |
| /docs/development/api-fundamentals/webhooks/receiving-webhooks.md | yes | raw |
| /docs/voice/programmable-voice/voice-api-webhooks.md | yes | raw |
| /docs/voice/programmable-voice/receiving-webhooks.md | yes | raw |
| /docs/messaging/messages/receiving-webhooks.md | yes | raw (signing and retry sections) |
| /docs/development/sdk/node/webhooks.md | yes | raw |
| /docs/voice/programmable-voice/tts.md | yes | raw |
| /docs/voice/programmable-voice/speech-to-text.md | yes | raw |
| /docs/voice/programmable-voice/conversation-relay.md | yes | raw (first part) |
| /docs/voice/programmable-voice/gather-using-ai.md | yes | raw (first part) |
| /docs/voice/programmable-voice/media-streaming.md | yes | raw (signing section) |
| /docs/voice/programmable-voice/l1-accounts-restirctions.md | yes | raw |
| /api-reference/call-commands/transcription-start.md | yes | raw (engine enum only) |
| /api-reference/call-commands/speak-text.md | yes | raw (payload limit only) |
| /api-reference/call-commands/gather-using-speak.md | yes | raw (not used) |
| /api-reference/integration-secrets/create-a-secret.md | yes | raw |
| /api-reference/phone-number-configurations/update-a-phone-number.md | yes | raw |
| /api-reference/phone-number-configurations/update-a-phone-number-with-voice-settings.md | yes | raw (not used) |
| /pricing.md | yes | raw |
| /compare.md | yes | raw (not used) |
| https://telnyx.com/pricing.md | yes | raw |
| https://telnyx.com/ai/capabilities.json | yes | raw (not used) |
| https://telnyx.com/pricing/call-control | yes | summariser |
| https://support.telnyx.com/en/articles/4374050-configuring-call-control-texml-applications-voice-api | yes | summariser (nothing beyond the developer docs; not cited) |

Web searches (used only to locate pages): three queries restricted to telnyx.com domains, on TeXML webhook timeout/retry, Gather speech attributes, and TeXML signature verification. One search result relayed a third-party claim (a hookdeck GitHub guide) that the Node SDK's `unwrap()` rejects real Telnyx requests; that page was not fetched and the claim is not relied on here.
