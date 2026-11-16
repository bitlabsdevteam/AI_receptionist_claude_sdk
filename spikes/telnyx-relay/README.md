# Spike: Telnyx Conversation Relay with fixed replies

A throwaway program for issue #22. It puts a real phone call through Telnyx Conversation Relay with fixed replies and
no model, so it measures Telnyx alone and spends nothing on Anthropic. It exists to make the fifteen experiments of
issue #23 possible. It lives on the branch `spike/telnyx-relay` and is never merged.

What it does on a call:

1. Accepts only webhooks signed by Telnyx (Ed25519, timestamp within 5 minutes). Anything else gets a 401.
2. Answers an inbound call from a Caller on the allowed list. Any other Caller is rejected, unanswered.
3. Starts the Relay with Call Control, pointed at this server with a single-use token that is good for 30 seconds.
4. When the Relay connection sends `setup`, sends the greeting. After that it echoes each final transcript as
   `You said: ...`.
5. Runs one experiment per key press (see Keys).
6. Writes every webhook, Relay frame, command and response to a JSON-lines file, each with a millisecond timestamp.

It does not call Anthropic, place a call or start `ngrok`.

**Nothing here has met the real Telnyx.** The tests run the program against a local stand-in for the Telnyx API, with
webhooks made by hand. They prove the wiring and the log. Whether Telnyx sends what its docs say is what the
experiments are for.

## Before the first call

The Telnyx account, the number, the keys and `ngrok` are set up by issue #21 (the setup wizard of #20). You need, in
`.env` at the repo root:

| Variable | Meaning |
|---|---|
| `TELNYX_API_KEY` | Sends the Call Control commands. Required. |
| `TELNYX_PUBLIC_KEY` | The public key from the Telnyx portal, as shown there (Base64 of 32 bytes). Required. |
| `PUBLIC_BASE_URL` | The public `https://` address of this server, which is the `ngrok` address. Required. |
| `PHONE_ALLOWED_CALLERS` | Comma-separated numbers in E.164 form. Set it to your own phone. When it is empty every Caller is answered, and the program says so at startup. |
| `TELNYX_TTS_VOICE` | The Relay's voice. Default `Telnyx.Ultra.Callie`. |
| `TELNYX_STT_ENGINE` | The speech recognition engine. Default `Deepgram`. |
| `TELNYX_STT_MODEL` | Its model. Default `deepgram/nova-3`. `none` sends no model. |
| `VOICE_LANGUAGE` | Default `en`. |
| `PORT` | Default `3000`. |
| `TELNYX_BASE_URL` | Default `https://api.telnyx.com`. The tests point it at a local stand-in. |

Settings that only the spike has:

| Variable | Meaning |
|---|---|
| `SPIKE_LOG_PATH` | The log file. Default: a new file per run in `spikes/telnyx-relay/logs/`, which is git-ignored. |
| `SPIKE_INTERRUPTIBLE` | `speech` (default), `any`, `dtmf` or `none`. |
| `SPIKE_GREETING_DELAY_MS` | Wait this long after `setup` before sending the greeting. Default `0`. |
| `SPIKE_SPEAK_VOICE` | The voice of Call Control `speak`. Default: the Relay's voice. |
| `SPIKE_START_EXTRA_JSON` | A JSON object merged into the Relay start request, to try a setting without changing code. A `transcription_engine_config` inside it is merged with the model. |

A variable that is already set in the shell wins over `.env`, so one call can try another voice:

```bash
TELNYX_TTS_VOICE=Telnyx.KokoroTTS.af npx tsx spikes/telnyx-relay/server.ts
```

The Voice API application in the Telnyx portal must use **webhook API version 2** and the webhook address
`<PUBLIC_BASE_URL>/telnyx/webhooks`.

## Start it

From the repo root, on the `spike/telnyx-relay` branch, after `npm ci`:

```bash
npx tsx spikes/telnyx-relay/server.ts
```

It prints the address to expect webhooks on, the port to point `ngrok` at, the log file, the settings in use and the
keys. A missing variable is named and the program exits 1.

`ngrok` is started by hand, in another terminal, and only when the person holding the phone says so:
`ngrok http 3000`. Its address must be the one in `PUBLIC_BASE_URL`.

Then dial the number from the phone on the allowed list. The terminal shows each event as it happens. Stop the program
with `Q` or Ctrl-C: it hangs up any call that is still up, so nothing is left running up a bill.

## Keys

Each key acts at once, with no Enter, on the latest call that is still up.

| Key | What it does | Experiments |
|---|---|---|
| `l` | Sends the long reply: ten numbered sentences, about 600 characters, last word "pineapple". | 4, 6 |
| `q` | Sends the long reply and, straight after it, a second reply whose last word is "umbrella". | 6 |
| `g` | Sends the greeting again. | 3 |
| `m` | Writes a marker in the log, with the number of final prompts since the marker before. | 7, 15 |
| `s` | Stops the Relay with the `conversation_relay_stop` command. The call stays up. | 9 |
| `e` | Ends the Relay with an `end` frame. The call stays up. | 9 |
| `d` | Drops the Relay connection with no close frame, as if the server had died. | 10 |
| `D` | Closes the Relay connection cleanly (close code 1000). | 10 |
| `k` | Speaks a fixed line with Call Control `speak`. Its last word is "lantern". | 10, 12 |
| `c` | The closing sequence: stop the Relay, `speak` the closing line (last word "goodbye"), wait for `call.speak.ended`, hang up. | 8, 9 |
| `C` | The same, but waits for `call.conversation.ended` (5 s at most) before `speak`. | 8 |
| `h` | Hangs up. | 9 |
| `?` | Shows the keys. | |
| `Q` or Ctrl-C | Hangs up any call still up, and quits. | |

When the program runs where nobody can type into it (an agent runs it in the background while the person holds the
phone), feed the keys through a file. Each character appended to the file is one key press:

```bash
mkdir -p spikes/telnyx-relay/logs && : > spikes/telnyx-relay/logs/keys      # the folder is git-ignored
tail -n 0 -f spikes/telnyx-relay/logs/keys | npx tsx spikes/telnyx-relay/server.ts
printf l >> spikes/telnyx-relay/logs/keys                                  # press l
printf Q >> spikes/telnyx-relay/logs/keys                                  # hang up and quit
```

After `Q` the `tail` is left over: stop it by its own process id.

## The log

One JSON object per line. Every line has `ts` (UTC, to the millisecond), `t_ms` (the same instant as a number) and
`kind`. Lines about a call also have `call` (`#1`, `#2`, in order of arrival) and `call_ms` (milliseconds since that
call's first webhook).

| `kind` | What it records |
|---|---|
| `start` | The settings of this run. |
| `webhook` | A signed webhook: `event_type`, `event_id`, `occurred_at`, `attempt`, `envelope` (`v2` or `unknown`), `duplicate`, `out_of_order`, its `headers` and its whole `body`. |
| `webhook.rejected` | A webhook that failed the signature check: the `reason`, its `headers` and `body`. Nothing was done with it. |
| `command`, `command.response` | A Call Control command and Telnyx's answer: `name`, the `body` sent, then `status`, `ms` and the response `body`. The two share an `id`. |
| `relay.handshake` | The Relay connection's HTTP upgrade: `headers` and `raw_headers` in full, `token` (`accepted`, `used`, `expired`, `unknown`) and `signature` (`absent`, `valid`, `invalid: ...`). |
| `relay.in` | A frame from Telnyx: `seq`, `type`, the whole `frame`, `known` (false for a type that is not in Telnyx's guide), `ms_since_last_in`, `ms_since_last_out`. |
| `relay.out` | A frame the spike sent: `seq`, the `frame`, and `why` (`greeting`, `echo`, or the key). |
| `relay.close` | The Relay connection closed: `by` (`us` or `telnyx`), `code`, `reason`, `ms_open`, `ms_since_last_in`, `ms_since_last_out`. |
| `relay.ping`, `relay.pong`, `relay.error` | What the names say. |
| `key`, `marker`, `closing` | A key press, a marker, and each step of the closing sequence with its `ms` since the key. |
| `http.other` | Any other HTTP request that reached the server. |

A key, a Relay token and a full phone number never reach the log or the terminal. Numbers are cut to their last four
digits (`+***0133`), the Caller's name becomes `[masked]`, and the API key and tokens become `[redacted]`. The log does
hold what was said on the call, so it stays out of git. Quote from it by hand.

To read it (`jq` is `brew install jq`):

```bash
LOG=$(ls -t spikes/telnyx-relay/logs/*.jsonl | head -1)                                  # the latest run
jq -c 'select(.kind=="relay.in") | {ts, seq, type, frame}' "$LOG"                        # frames from Telnyx
jq -c 'select(.kind=="webhook") | {ts, seq, event_type, envelope, attempt, duplicate, out_of_order}' "$LOG"
jq -c 'select(.kind=="command.response") | {ts, name, status, ms, body}' "$LOG"
jq -c '{ts, kind, type, event_type, name, why, step}' "$LOG"                             # the whole run, one line each
```

## The experiments

The numbers are the ones in issue #23. Run each at least three times. Each run of the program writes its own log file,
so note which file belongs to which experiment.

### The Relay connection

**1. Is the handshake signed? List its headers.**
Do: dial, wait for the greeting, hang up.
Look at: the `relay.handshake` line. `raw_headers` lists every header as it arrived. `signature` is `absent` when
there is no `telnyx-signature-ed25519` header, `valid` when the handshake is signed the way Telnyx signs a media stream
(Ed25519 over `<telnyx-timestamp>|<the wss:// address the Relay was started with>`), and `invalid: ...` when the headers
are there but that scheme does not fit. `x-forwarded-*` and `ngrok-*` headers are added by `ngrok`, not by Telnyx.

```bash
jq 'select(.kind=="relay.handshake") | {token, signature, raw_headers}' "$LOG"
```

**2. Does a `prompt` with `last: true` carry the whole utterance, or only its last part?**
Do: after the greeting, say in one breath: "I would like to book a table for four people on Friday evening at seven
o'clock." Listen to the echo.
Look at: the `relay.in` lines with `type: "prompt"`. One line with `frame.last: true` whose `frame.voicePrompt` is the
whole sentence means the whole utterance. Several `last: true` lines, each with a piece, means it arrives in parts. To
see partial prompts as well, run with Deepgram Flux:
`TELNYX_STT_MODEL=deepgram/flux SPIKE_START_EXTRA_JSON='{"transcription_engine_config":{"interim_results":true}}'`,
and compare the `last: false` lines with the `last: true` line that follows them.

**3. How long from the call arriving to `setup`? Is text sent straight after `setup` spoken in full?**
Do: dial and listen to the very start. The greeting begins with "Hello".
Look at: the `relay.in` line with `type: "setup"`. `ms_since_call_arrived` is the time from the `call.initiated`
webhook to `setup`. `ms_since_answered`, `ms_since_start_command` and `ms_since_connected` split it up. The greeting is
the `relay.out` line straight after it, with the same timestamp.
If "Hello" is clipped: run again with `SPIKE_GREETING_DELAY_MS=200`, then `400`, and so on, and record the smallest
delay at which it is whole. Press `g` mid-call to hear the greeting unclipped for comparison.

**4. Is a reply of about 600 characters spoken in full?**
Do: after the greeting press `l`, and stay silent. Count the ten numbered sentences. The last word is "pineapple".
Look at: the `relay.out` line with `why: "key l: long reply"`, and whether a `relay.in` line with `type: "error"` or
`type: "interrupt"` follows it. An `interrupt` means the phone's microphone cut it off: mute the phone and try again.

**5. Does Telnyx end the Relay when the line is silent for 60 seconds?**
Do: after the greeting, mute the phone, press nothing and wait 90 seconds.
Look at: whether a `relay.close` line appears, with `by: "telnyx"`, its `code`, `reason` and `ms_since_last_in`.
Look also for a `call.conversation.ended` webhook (its `body.data.payload.reason`) and a `call.hangup` webhook. If none
of them comes, unmute and speak: an echo shows the Relay is still up.

### Interrupting

**6. When the Caller talks over a reply.**
Do, part one: press `l`. At about sentence three say loudly "stop, I have a question". Note whether the speech stops,
how quickly, and whether the long reply carries on after the echo of your words.
Do, part two: press `q`. Interrupt during the long reply as before. Note whether the queued reply (last word
"umbrella") is still spoken.
Look at: the `relay.in` lines after the `relay.out`. Their `seq` gives the order of `interrupt` and `prompt`. The
`interrupt` frame has `utteranceUntilInterrupt` and `durationUntilInterruptMs`: compare them with what you heard.
`ms_since_last_out` on the `interrupt` line is the time since the reply was sent.

```bash
jq -c 'select(.kind=="relay.in" or .kind=="relay.out") | {ts, kind, seq, type, why, ms_since_last_out, frame}' "$LOG"
```

**7. One sentence with a natural pause, ten times.**
Do: press `m`. Say "I would like to book a table", pause for about a second, "for two people tomorrow." Wait for the
echo. Repeat until you have said it ten times, pressing `m` before each one, and press `m` once more at the end.
Look at: the `marker` lines 2 to 11. `final_prompts_since_last_marker` is `1` when the sentence arrived as one
utterance and `2` when it was split in two. Count the lines that are not `1`.
Repeat with each engine being compared, one run each, for example:

```bash
TELNYX_STT_ENGINE=Deepgram TELNYX_STT_MODEL=deepgram/nova-3 npx tsx spikes/telnyx-relay/server.ts   # the default
TELNYX_STT_ENGINE=Deepgram TELNYX_STT_MODEL=deepgram/flux   npx tsx spikes/telnyx-relay/server.ts
TELNYX_STT_ENGINE=Telnyx   TELNYX_STT_MODEL=openai/whisper-large-v3-turbo npx tsx spikes/telnyx-relay/server.ts
TELNYX_STT_ENGINE=Google   TELNYX_STT_MODEL=none            npx tsx spikes/telnyx-relay/server.ts
```

Flux's end-of-turn threshold can be changed with
`SPIKE_START_EXTRA_JSON='{"transcription_engine_config":{"eot_threshold":0.8}}'` (0.5 to 0.9, default 0.7).

### Ending and trouble

**8. Does the closing sequence work?**
Do: after the greeting press `c`. Listen for: whether anything is cut off, the length of the silence before the closing
line, whether the line is whole (last word "goodbye"), whether it sounds like the greeting's voice, and whether the
call then hangs up. Then try it during speech: press `l`, and `c` at about sentence three. Then try `C`, which waits
for `call.conversation.ended` before it speaks.
Look at: the `closing` lines, whose `ms` is the time since the key: `stop answered`, `speak answered`,
`call.speak.started arrived`, `call.speak.ended arrived` (with `status`), `hangup answered`. The gap heard is roughly
from `stop answered` to `call.speak.started arrived`. Look at the `command.response` lines for a `status` that is not
200, and at the order of the `relay.close` line and the `call.conversation.ended`, `call.speak.ended` and `call.hangup`
webhooks. If `speak` is refused the sequence stops and says so: press `h`.
If this does not hold on a real call, stop and say so on issue #23. The fallback to TeXML is the person's decision.

```bash
jq -c 'select(.kind=="closing" or .kind=="command.response" or .kind=="webhook" or .kind=="relay.close")
       | {ts, kind, step, ms, name, status, event_type, by, code}' "$LOG"
```

**9. What does `call.conversation.ended` report in each case?**
Do: six calls, each ended a different way: `s` (stop command), `e` (`end` frame), `d` (dropped connection), `h` (hang
up by command), hanging up on the phone, and `c` (closing sequence). After `s`, `e` and `d` the call may stay up: wait
ten seconds, then press `h`.
Look at: the webhook's whole payload in each log, and whether it came at all.

```bash
jq 'select(.event_type=="call.conversation.ended") | .body.data.payload' "$LOG"
```

**10. Drop the Relay connection mid-call.**
Do: after the greeting press `d`. Watch the terminal for 30 seconds. Speak: there should be no echo. Press `k` and
listen for the line that ends in "lantern". Press `h`. Repeat with `D` in place of `d`.
Look at: the `relay.close` line (`by: "us"`), then which webhooks follow and when: `call.conversation.ended` (is
`reason` `customer_disconnect`?) and `call.hangup` (did Telnyx hang up, or does the call stay up?). For `k`, the
`command.response` line of `speak`: `status` 200 and a `call.speak.ended` webhook mean `speak` still works.

### Webhooks and account

**11. Version 2 envelope, the Ed25519 check, duplicates and order.**
Do: nothing extra. Every call answers this.
Look at: every `webhook` line. `envelope: "v2"` and `signature: "valid"` are the expected values. A `webhook.rejected`
line means the check failed, with the `reason`. If every webhook is rejected with `signature does not match`, check
`TELNYX_PUBLIC_KEY` and the application's webhook API version: the rejected `body` shows the shape that arrived.
`duplicate: true` marks an event id seen before, `attempt` is Telnyx's delivery count, and `out_of_order: true` marks
an `occurred_at` earlier than one already seen for that call.

```bash
jq -c 'select(.kind=="webhook" or .kind=="webhook.rejected")
       | {ts, kind, reason, event_type, envelope, signature, attempt, duplicate, out_of_order, occurred_at}' "$LOG"
```

**12. Is the abuse notice spoken before Relay speech or before `speak`?**
Do: listen to the start of the greeting, which is Relay speech. Then press `k`, which is `speak`. The notice begins
"This is an automated call generated on the Telnyx platform".
Look at: the log cannot hear it. A hint for `speak`: the time between the `call.speak.started` and `call.speak.ended`
webhooks after `k`. The line itself takes about four seconds.

**13. What did the calls cost, and does the Relay's price include speech recognition and speech?**
Do: after the calls, read the charges in the Telnyx portal, line by line.
Look at: the log gives the durations to set against them: `call_ms` on the `call.hangup` line and `ms_open` on the
`relay.close` line. If the application has call cost in webhooks switched on, a `call.cost` webhook is logged too. The
spike reads no billing API.

### Choosing by ear

**14. Compare two or three voices and the engines. Choose the defaults.**
Do: one call per setting, started with `TELNYX_TTS_VOICE=...` and `TELNYX_STT_ENGINE=... TELNYX_STT_MODEL=...` as in
experiment 7. On each, listen to the greeting, press `l` for a long stretch of the voice, and say the sentences of
experiments 2 and 7 for the engine. Press `k` to hear the same voice through `speak`, or set `SPIKE_SPEAK_VOICE` to
hear another one there.
Look at: the `start` line, and the `body` of the `conversation_relay_start` command, for what each call used. Telnyx
lists its voices at `GET /v2/text-to-speech/voices`. The spike does not call it.

**15. The wait from the end of the Caller's speech to the start of the reply.**
Do: record your own test call on a second device. Press `m`, say a short sentence, wait for the echo, a few times.
In the recording, measure from the end of your words to the start of "You said".
Look at: the `relay.in` final `prompt` line and the `relay.out` echo line after it. Their `t_ms` are the same to
within a millisecond or two, because a fixed reply is sent the moment the prompt arrives. So the whole wait you
measured is Telnyx: hearing that you stopped, and starting to speak. A real Turn adds the model's time on top. Delete
the recording afterwards.

## Tests

```bash
npx vitest run spikes/telnyx-relay        # the spike's tests only, offline
npx tsc -p spikes/telnyx-relay            # typecheck the spike (the repo's typecheck does not cover it)
```

`npm test` at the repo root runs them too. They never call Telnyx, start `ngrok` or place a call.

- `signature.test.ts`: the Ed25519 check over `<timestamp>|<raw body>`, the 5 minute window, and the handshake check.
- `frames.test.ts`: the frames of Telnyx's guide, and which of them get a reply.
- `log.test.ts`: masking of keys, phone numbers and the Caller's name.
- `server.test.ts`: the acceptance check. The real program is run in a child process with its settings in a `.env`
  file, a local HTTP server stands in for the Telnyx API, the webhooks are made by hand and signed with a throwaway
  key, and a local WebSocket client plays Telnyx's side of the Relay connection.

What the acceptance check proves: the program starts from `.env` and prints the webhook address, refuses an unsigned
webhook, answers an allowed Caller and rejects another, starts the Relay with the configured settings, greets, echoes
a final prompt and only a final one, sends the long reply, runs the closing sequence in order and hangs up only after
`call.speak.ended`, acts once on a duplicated webhook, lets a Relay token be used once, and logs all of it with no key
and no full phone number in the file or on the terminal.

What it cannot prove: that Telnyx's webhooks, signatures, command responses and Relay frames look the way its docs say.
The stand-in answers 200 to everything, and the hand-made frames are copied from the docs' examples.

## Telnyx's docs, checked on 2026-11-16

The endpoints, events, signature scheme and frames in `docs/research/telnyx/relay.md` and `call-control.md` were
checked against the pages Telnyx serves today (the Conversation Relay guide, the reference pages for
`conversation_relay_start`, `conversation_relay_stop`, `answer`, `reject`, `hangup` and `speak`, the webhook pages, the
event catalogue and the Node SDK's signature code). They agree, except for these points, which the notes leave out:

1. **`reject` needs a `cause`.** The request body requires `cause`, one of `CALL_REJECTED`, `NOT_FOUND`,
   `TEMPORARILY_UNAVAILABLE`, `USER_BUSY`. The notes give the endpoint with no body. The spike sends `CALL_REJECTED`.
2. **`speak` takes locale codes for `language`.** Its `language` is a fixed list (`en-US`, `en-GB`, ...), with no bare
   `en`. The Relay's `language` defaults to `en`. So `VOICE_LANGUAGE=en` cannot be handed to `speak` as it is. The
   spike sends no `language` with `speak`.
3. **The direction is spelled two ways.** The `call.initiated` webhook says `direction: "incoming"`. The Relay's
   `setup` frame says `direction: "inbound"`. The notes list the field and not the value.
4. **`call.conversation.start_failed` exists.** The event catalogue has it, for an AI assistant that could not be
   started from `answer` or `dial`. Nothing says it is sent for the Relay. The spike logs it if it comes.
5. **The abuse notice list is longer.** It also names `gather_using_audio` and the TeXML verbs `Play` and `Say`. It
   still does not name the Relay, so experiment 12 stands.

Still not in Telnyx's docs, and so still for the experiments: any signature on the Relay handshake, what happens to
queued speech on an interruption, the `reason` values of `call.conversation.ended`, what the call does when the Relay
connection drops, and any limit on the length of a `text` frame.

## Files

| File | What it holds |
|---|---|
| `server.ts` | The program: `.env`, the settings, the keys, Ctrl-C. |
| `spike.ts` | The HTTP server, the webhooks, the commands, the Relay connection and the experiments. |
| `signature.ts` | The Ed25519 checks. |
| `frames.ts` | The Relay frames and the fixed replies. |
| `log.ts` | The JSON-lines log and the masking. |
| `ws.d.ts` | The few types of `ws` the spike uses, since `ws` ships none. |
