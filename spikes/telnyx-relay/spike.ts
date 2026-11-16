import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  CLOSING_LINE,
  finalPrompt,
  GREETING,
  LONG_REPLY,
  QUEUED_REPLY,
  readFrame,
  repliesTo,
  SPEAK_LINE,
  textFrame,
} from "./frames.js";
import { openLog, type SpikeLog } from "./log.js";
import { checkRelayHandshake, checkWebhookSignature, publicKeyFrom } from "./signature.js";

/**
 * The spike: a real call through Telnyx Conversation Relay with fixed replies and no model. It answers a signed
 * inbound call, starts the Relay, greets, echoes what Telnyx heard, and runs one experiment per key press. Everything
 * that arrives or is sent goes to a JSON-lines file. A throwaway: it is never merged.
 */

export const WEBHOOK_PATH = "/telnyx/webhooks";
export const RELAY_PATH = "/telnyx/relay/";

/** How long a Relay token is good for after the Relay is started, as the spec says. */
const TOKEN_TTL_MS = 30_000;
const COMMAND_TIMEOUT_MS = 10_000;
const SPEAK_ENDED_TIMEOUT_MS = 30_000;
const RELAY_ENDED_TIMEOUT_MS = 5_000;

export interface SpikeConfig {
  apiKey: string;
  publicKey: string;
  publicBaseUrl: string;
  telnyxBaseUrl: string;
  /** Empty means every Caller is answered. */
  allowedCallers: string[];
  voice: string;
  sttEngine: string;
  sttModel: string;
  language: string;
  port: number;
  logPath: string;
  interruptible: string;
  /** Wait this long after `setup` before sending the greeting (experiment 3, if the first word is clipped). */
  greetingDelayMs: number;
  /** The voice of Call Control `speak`. The Relay's voice unless set. */
  speakVoice: string;
  /** Extra fields for the Relay start request, to try a setting without changing code. */
  startExtra: Record<string, unknown>;
}

export const KEYS: Array<[key: string, what: string]> = [
  ["l", "send the long reply (about 600 characters)"],
  ["q", "send the long reply and a second, queued reply straight after it"],
  ["g", "send the greeting again"],
  ["m", "write a marker in the log (press before each test sentence)"],
  ["s", "stop the Relay with the conversation_relay_stop command"],
  ["e", "end the Relay with an `end` frame"],
  ["d", "drop the Relay connection (no close frame, as if the server died)"],
  ["D", "close the Relay connection cleanly (close code 1000)"],
  ["k", "speak a fixed line with Call Control `speak`"],
  ["c", "closing sequence: stop the Relay, speak, wait for call.speak.ended, hang up"],
  ["C", "the same, but wait for call.conversation.ended before speak"],
  ["h", "hang up"],
  ["?", "show this list"],
];

/** Reads the settings from the environment. Returns the lines to print when it cannot start. */
export function readConfig(env: NodeJS.ProcessEnv, defaultLogDir: string): SpikeConfig | { problems: string[] } {
  const value = (name: string) => env[name]?.trim() || undefined;
  const problems: string[] = [];
  const required = (name: string, what: string): string => {
    const found = value(name);
    if (!found) problems.push(`${name} is not set. ${what}`);
    return found ?? "";
  };

  const apiKey = required("TELNYX_API_KEY", "Put your Telnyx API key in .env. It sends the Call Control commands.");
  const publicKey = required("TELNYX_PUBLIC_KEY", "Put the public key from the Telnyx portal in .env. It checks webhook signatures.");
  const publicBaseUrl = required("PUBLIC_BASE_URL", "Put the public https:// address of this server (the ngrok address) in .env.");
  if (publicKey) {
    try {
      publicKeyFrom(publicKey);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (publicBaseUrl && !/^https?:\/\//.test(publicBaseUrl)) problems.push("PUBLIC_BASE_URL must start with https:// (or http://).");

  let startExtra: Record<string, unknown> = {};
  const extra = value("SPIKE_START_EXTRA_JSON");
  if (extra) {
    try {
      const parsed: unknown = JSON.parse(extra);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      startExtra = parsed as Record<string, unknown>;
    } catch {
      problems.push("SPIKE_START_EXTRA_JSON must be a JSON object.");
    }
  }
  const number = (name: string, fallback: number): number => {
    const found = value(name);
    if (found === undefined) return fallback;
    if (!/^\d+$/.test(found)) problems.push(`${name} must be a whole number.`);
    return Number(found);
  };
  const port = number("PORT", 3000);
  const greetingDelayMs = number("SPIKE_GREETING_DELAY_MS", 0);
  if (problems.length > 0) return { problems };

  const voice = value("TELNYX_TTS_VOICE") ?? "Telnyx.Ultra.Callie";
  return {
    apiKey,
    publicKey,
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ""),
    telnyxBaseUrl: (value("TELNYX_BASE_URL") ?? "https://api.telnyx.com").replace(/\/+$/, ""),
    allowedCallers: (value("PHONE_ALLOWED_CALLERS") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
    voice,
    sttEngine: value("TELNYX_STT_ENGINE") ?? "Deepgram",
    sttModel: value("TELNYX_STT_MODEL") ?? "deepgram/nova-3",
    language: value("VOICE_LANGUAGE") ?? "en",
    port,
    logPath: value("SPIKE_LOG_PATH") ?? join(defaultLogDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`),
    interruptible: value("SPIKE_INTERRUPTIBLE") ?? "speech",
    greetingDelayMs,
    speakVoice: value("SPIKE_SPEAK_VOICE") ?? voice,
    startExtra,
  };
}

interface RelayConnection {
  socket: WebSocket;
  openedAt: number;
  lastInAt?: number;
  lastOutAt?: number;
  inSeq: number;
  outSeq: number;
  closedByUs: boolean;
}

interface Call {
  /** Telnyx's `call_control_id`. */
  id: string;
  /** `#1`, `#2`, ... in the order the calls arrived. */
  label: string;
  arrivedAt: number;
  answeredAt?: number;
  startSentAt?: number;
  relayUrl?: string;
  relay?: RelayConnection;
  latestOccurredAt?: string;
  ended: boolean;
  waiters: Array<{ eventType: string; done: (payload: Record<string, unknown> | undefined) => void }>;
  finalPrompts: number;
  finalPromptsAtLastMarker: number;
  markers: number;
}

interface Token {
  call: Call;
  issuedAt: number;
  used: boolean;
}

export interface Spike {
  /** The port it listens on. */
  port: number;
  /** One key press from the terminal. */
  press(key: string): void;
  /** Hangs up any call still up, then closes the servers. */
  quit(): Promise<void>;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digitsOf(number: string): string {
  return number.replace(/\D/g, "");
}

/** Telnyx's examples put the `call_control_id` in the path as it is (`v3:...`), so only what a path cannot hold is escaped. */
function pathSegment(text: string): string {
  return text.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]+/g, encodeURIComponent);
}

function clip(text: unknown, max = 70): string {
  const line = String(text);
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

function clock(t: number): string {
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** One terminal line for a log record. It is built from the masked record, so it shows no more than the file does. */
function describe(record: Json): string | undefined {
  const call = record.call ? ` [${String(record.call)}]` : "";
  switch (record.kind) {
    case "webhook": {
      const payload = isObject(record.body) && isObject(record.body.data) && isObject(record.body.data.payload) ? record.body.data.payload : {};
      const detail = [
        payload.from !== undefined && record.event_type === "call.initiated" ? `from ${String(payload.from)}` : "",
        payload.reason !== undefined ? `reason ${String(payload.reason)}` : "",
        payload.status !== undefined ? `status ${String(payload.status)}` : "",
        payload.hangup_cause !== undefined ? `${String(payload.hangup_cause)}, by ${String(payload.hangup_source)}` : "",
        record.envelope === "v2" ? "" : `ENVELOPE ${String(record.envelope)}`,
        record.duplicate ? "DUPLICATE" : "",
        record.out_of_order ? "OUT OF ORDER" : "",
      ].filter(Boolean);
      return `<- webhook ${String(record.event_type)}${call}${detail.length > 0 ? ` (${detail.join("; ")})` : ""}`;
    }
    case "webhook.rejected":
      return `<- webhook REJECTED: ${String(record.reason)}`;
    case "http.other":
      return `<- ${String(record.method)} ${String(record.url)} (not a webhook)`;
    case "command":
      return `-> command ${String(record.name)}${call}`;
    case "command.response":
      return record.error !== undefined
        ? `<- ${String(record.name)} FAILED after ${String(record.ms)} ms: ${String(record.error)}`
        : `<- ${String(record.name)} ${String(record.status)} in ${String(record.ms)} ms${Number(record.status) >= 400 ? `: ${clip(JSON.stringify(record.body), 200)}` : ""}`;
    case "relay.handshake":
      return `<- Relay handshake${call}: token ${String(record.token)}, signature ${String(record.signature)}`;
    case "relay.in": {
      const frame = isObject(record.frame) ? record.frame : {};
      if (record.type === "setup") return `<- Relay setup${call}: ${String(record.ms_since_call_arrived)} ms after the call arrived`;
      if (record.type === "prompt") return `<- Relay prompt${call} last=${String(frame.last)} "${clip(frame.voicePrompt)}"`;
      if (record.type === "interrupt") {
        return `<- Relay interrupt${call} after ${String(frame.durationUntilInterruptMs)} ms: "${clip(frame.utteranceUntilInterrupt)}"`;
      }
      return `<- Relay ${String(record.type)}${call}${record.known ? "" : " (NOT IN THE GUIDE)"} ${clip(JSON.stringify(record.frame ?? record.raw), 120)}`;
    }
    case "relay.out": {
      const frame = isObject(record.frame) ? record.frame : {};
      return `-> Relay ${String(frame.type)}${call} (${String(record.why)})${frame.token !== undefined ? ` "${clip(frame.token)}"` : ""}`;
    }
    case "relay.ping":
    case "relay.pong":
      return `<- Relay ${String(record.kind).slice(6)}${call}`;
    case "relay.close":
      return `Relay closed${call} by ${String(record.by)}: code ${String(record.code)} "${String(record.reason)}", open ${String(record.ms_open)} ms, ${String(record.ms_since_last_in)} ms after the last frame in`;
    case "relay.error":
      return `Relay error${call}: ${String(record.error)}`;
    case "key":
      return `key ${String(record.key)}${call}: ${String(record.action)}`;
    case "marker":
      return `marker ${String(record.n)}${call}: ${String(record.final_prompts_since_last_marker)} final prompt(s) since the marker before`;
    case "closing":
      return `closing${call}: ${String(record.step)} (+${String(record.ms)} ms)`;
    case "note":
      return String(record.note);
    case "error":
      return `ERROR: ${String(record.error)}`;
    default:
      return undefined;
  }
}

export async function startSpike(config: SpikeConfig, print: (line: string) => void): Promise<Spike> {
  const log: SpikeLog = openLog(config.logPath);
  log.addSecret(config.apiKey);
  for (const caller of config.allowedCallers) log.addNumber(caller);
  const allowed = new Set(config.allowedCallers.map(digitsOf));
  const relayBase = `${config.publicBaseUrl.replace(/^http/, "ws")}${RELAY_PATH}`;

  const calls = new Map<string, Call>();
  const tokens = new Map<string, Token>();
  const seenEvents = new Set<string>();
  let webhookSeq = 0;
  let commandSeq = 0;

  /** Writes to the log, and to the terminal when the record has a line. */
  function record(kind: string, fields: Json = {}): void {
    const written = log.write(kind, fields);
    const line = describe(written);
    if (line !== undefined) print(`${clock(written.t_ms as number)}  ${line}`);
  }

  function note(text: string): void {
    record("note", { note: text });
  }

  function callFields(call: Call | undefined): Json {
    return call ? { call: call.label, call_ms: Date.now() - call.arrivedAt } : {};
  }

  /** The call the keys act on: the latest one that has not hung up. */
  function currentCall(): Call | undefined {
    return [...calls.values()].reverse().find((call) => !call.ended);
  }

  function waitFor(call: Call, eventType: string, timeoutMs: number): Promise<Json | undefined> {
    return new Promise((resolve) => {
      const waiter = {
        eventType,
        done: (payload: Json | undefined) => {
          clearTimeout(timer);
          call.waiters = call.waiters.filter((other) => other !== waiter);
          resolve(payload);
        },
      };
      const timer = setTimeout(() => waiter.done(undefined), timeoutMs);
      timer.unref();
      call.waiters.push(waiter);
    });
  }

  // ---- Call Control commands

  async function command(call: Call, name: string, body: Json = {}): Promise<{ ok: boolean; status?: number }> {
    const id = ++commandSeq;
    const sent = { ...body, command_id: randomUUID() };
    record("command", { id, name, ...callFields(call), call_control_id: call.id, body: sent });
    const started = Date.now();
    try {
      const response = await fetch(`${config.telnyxBaseUrl}/v2/calls/${pathSegment(call.id)}/actions/${name}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(sent),
        signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON: the text is logged as it is.
      }
      record("command.response", {
        id,
        name,
        ...callFields(call),
        status: response.status,
        ms: Date.now() - started,
        headers: Object.fromEntries(response.headers),
        body: parsed,
      });
      return { ok: response.ok, status: response.status };
    } catch (error) {
      // `fetch failed` says nothing by itself: the reason is in its cause. Neither holds the key, and the log would
      // redact it if one did.
      const cause = (error as Error).cause;
      const reason = `${(error as Error).message}${cause instanceof Error ? `: ${cause.message}` : ""}`;
      record("command.response", { id, name, ...callFields(call), ms: Date.now() - started, error: reason });
      return { ok: false };
    }
  }

  function speakBody(payload: string): Json {
    return { payload, voice: config.speakVoice };
  }

  function startRelay(call: Call): Promise<unknown> {
    const token = randomBytes(24).toString("base64url");
    log.addSecret(token);
    tokens.set(token, { call, issuedAt: Date.now(), used: false });
    call.relayUrl = `${relayBase}${token}`;
    call.startSentAt = Date.now();
    const extraStt = isObject(config.startExtra.transcription_engine_config) ? config.startExtra.transcription_engine_config : {};
    // `none` sends no model, for an engine that does not take `transcription_model` (Google takes `model`).
    const model = config.sttModel === "none" ? {} : { transcription_model: config.sttModel };
    return command(call, "conversation_relay_start", {
      url: call.relayUrl,
      voice: config.voice,
      language: config.language,
      transcription_engine: config.sttEngine,
      interruptible: config.interruptible,
      dtmf_detection: false,
      ...config.startExtra,
      transcription_engine_config: { ...model, ...extraStt },
    });
  }

  // ---- Webhooks

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async function onWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString());
    } catch {
      body = undefined;
    }
    const data = isObject(body) && isObject(body.data) ? body.data : undefined;
    const payload = data && isObject(data.payload) ? data.payload : {};
    for (const field of [payload.from, payload.to]) if (typeof field === "string") log.addNumber(field);

    const check = checkWebhookSignature(raw, req.headers, config.publicKey, Date.now() / 1000);
    if (!check.ok) {
      res.writeHead(401).end();
      record("webhook.rejected", { reason: check.reason, headers: req.headers, body: body ?? raw.toString().slice(0, 4000) });
      return;
    }
    // Telnyx asks for a 200 at once. The work happens after it.
    res.writeHead(200).end();

    const eventType = data && typeof data.event_type === "string" ? data.event_type : undefined;
    const eventId = data && typeof data.id === "string" ? data.id : undefined;
    const occurredAt = data && typeof data.occurred_at === "string" ? data.occurred_at : undefined;
    const callId = typeof payload.call_control_id === "string" ? payload.call_control_id : undefined;
    const duplicate = eventId !== undefined && seenEvents.has(eventId);
    if (eventId !== undefined) seenEvents.add(eventId);

    // A call is known from its first webhook, whatever that is, so that a call the spike did not see arrive (it was
    // restarted, say) can still be hung up with a key.
    let call = callId === undefined ? undefined : calls.get(callId);
    if (!call && callId !== undefined) {
      call = {
        id: callId,
        label: `#${calls.size + 1}`,
        arrivedAt: Date.now(),
        ended: eventType === "call.hangup",
        waiters: [],
        finalPrompts: 0,
        finalPromptsAtLastMarker: 0,
        markers: 0,
      };
      calls.set(callId, call);
    }
    const outOfOrder = Boolean(call?.latestOccurredAt && occurredAt && occurredAt < call.latestOccurredAt);
    if (call && occurredAt && !outOfOrder) call.latestOccurredAt = occurredAt;

    record("webhook", {
      seq: ++webhookSeq,
      signature: "valid",
      // Version 2 wraps the event in `data` with `record_type: "event"`. Anything else is not what the spec expects.
      envelope: data && data.record_type === "event" && eventType !== undefined && isObject(data.payload) ? "v2" : "unknown",
      event_type: eventType,
      event_id: eventId,
      occurred_at: occurredAt,
      attempt: isObject(body) && isObject(body.meta) ? body.meta.attempt : undefined,
      duplicate,
      out_of_order: outOfOrder,
      ...callFields(call),
      headers: req.headers,
      body: body ?? raw.toString().slice(0, 4000),
    });
    if (duplicate || !call || eventType === undefined) return;

    for (const waiter of call.waiters.filter((waiting) => waiting.eventType === eventType)) waiter.done(payload);

    if (eventType === "call.initiated") {
      if (payload.direction !== "incoming") return note(`${call.label} is not an incoming call. Nothing is done with it.`);
      const from = typeof payload.from === "string" ? digitsOf(payload.from) : "";
      if (allowed.size > 0 && !allowed.has(from)) {
        call.ended = true;
        await command(call, "reject", { cause: "CALL_REJECTED" });
        return;
      }
      await command(call, "answer");
    } else if (eventType === "call.answered") {
      call.answeredAt = Date.now();
      await startRelay(call);
    } else if (eventType === "call.hangup") {
      call.ended = true;
      for (const waiter of [...call.waiters]) waiter.done(undefined);
    }
  }

  // ---- The Relay connection

  function send(call: Call, frame: Json, why: string): void {
    const relay = call.relay;
    if (!relay) return note(`${call.label} has no Relay connection, so nothing was sent (${why}).`);
    relay.socket.send(JSON.stringify(frame));
    relay.lastOutAt = Date.now();
    record("relay.out", { seq: ++relay.outSeq, why, ...callFields(call), frame });
  }

  function onRelayFrame(call: Call, relay: RelayConnection, raw: string): void {
    const now = Date.now();
    const frame = readFrame(raw);
    const fields: Json = {
      seq: ++relay.inSeq,
      type: frame.type,
      known: frame.known,
      ...callFields(call),
      ms_since_last_in: relay.lastInAt === undefined ? null : now - relay.lastInAt,
      ms_since_last_out: relay.lastOutAt === undefined ? null : now - relay.lastOutAt,
      ...("body" in frame ? { frame: frame.body } : { raw: frame.raw }),
    };
    if (frame.type === "setup" && "body" in frame) {
      fields.ms_since_call_arrived = now - call.arrivedAt;
      fields.ms_since_answered = call.answeredAt === undefined ? null : now - call.answeredAt;
      fields.ms_since_start_command = call.startSentAt === undefined ? null : now - call.startSentAt;
      fields.ms_since_connected = now - relay.openedAt;
      fields.matches_call = frame.body.callControlId === call.id;
    }
    relay.lastInAt = now;
    if (finalPrompt(frame) !== undefined) call.finalPrompts += 1;
    record("relay.in", fields);

    const replies = repliesTo(frame);
    const why = frame.type === "setup" ? "greeting" : "echo";
    const sendReplies = () => replies.forEach((reply) => call.relay === relay && send(call, { ...reply }, why));
    if (frame.type === "setup" && config.greetingDelayMs > 0) setTimeout(sendReplies, config.greetingDelayMs).unref();
    else sendReplies();
  }

  const sockets = new WebSocketServer({ noServer: true });

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = req.url ?? "";
    const token = url.startsWith(RELAY_PATH) ? url.slice(RELAY_PATH.length).split(/[/?]/)[0] ?? "" : "";
    const issued = tokens.get(token);
    const state = !issued ? "unknown" : issued.used ? "used" : Date.now() - issued.issuedAt > TOKEN_TTL_MS ? "expired" : "accepted";
    const call = issued?.call;
    record("relay.handshake", {
      token: state,
      // Experiment 1: is the handshake signed? Tried the way Telnyx signs a media stream, over `<timestamp>|<url>`.
      signature: call?.relayUrl ? checkRelayHandshake(req.headers, call.relayUrl, config.publicKey, Date.now() / 1000) : "not checked",
      ...callFields(call),
      ms_since_start_command: call?.startSentAt === undefined ? null : Date.now() - call.startSentAt,
      method: req.method,
      url,
      http_version: req.httpVersion,
      remote_address: req.socket.remoteAddress,
      headers: req.headers,
      raw_headers: req.rawHeaders,
    });
    if (!issued || !call || state !== "accepted") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    issued.used = true;

    sockets.handleUpgrade(req, socket, head, (ws) => {
      const relay: RelayConnection = { socket: ws, openedAt: Date.now(), inSeq: 0, outSeq: 0, closedByUs: false };
      call.relay = relay;
      ws.on("message", (data, isBinary) => {
        try {
          if (isBinary) record("relay.in", { seq: ++relay.inSeq, type: "binary", known: false, ...callFields(call), bytes: data.length });
          else onRelayFrame(call, relay, data.toString());
        } catch (error) {
          record("error", { where: "relay frame", error: (error as Error).message });
        }
      });
      ws.on("ping", (data) => record("relay.ping", { ...callFields(call), data: data.toString("base64") }));
      ws.on("pong", (data) => record("relay.pong", { ...callFields(call), data: data.toString("base64") }));
      ws.on("error", (error) => record("relay.error", { ...callFields(call), error: error.message }));
      ws.on("close", (code, reason) => {
        const now = Date.now();
        if (call.relay === relay) call.relay = undefined;
        record("relay.close", {
          ...callFields(call),
          by: relay.closedByUs ? "us" : "telnyx",
          code,
          reason: reason.toString(),
          ms_open: now - relay.openedAt,
          ms_since_last_in: relay.lastInAt === undefined ? null : now - relay.lastInAt,
          ms_since_last_out: relay.lastOutAt === undefined ? null : now - relay.lastOutAt,
          frames_in: relay.inSeq,
          frames_out: relay.outSeq,
        });
      });
    });
  }

  // ---- The experiments, one per key

  async function closingSequence(call: Call, waitForRelayEnded: boolean): Promise<void> {
    const began = Date.now();
    const step = (name: string, extra: Json = {}) => record("closing", { call: call.label, step: name, ms: Date.now() - began, ...extra });
    step(waitForRelayEnded ? "begin (C: speak after call.conversation.ended)" : "begin (c: speak as soon as the stop command is answered)");
    const relayEnded = waitFor(call, "call.conversation.ended", RELAY_ENDED_TIMEOUT_MS);
    const stop = await command(call, "conversation_relay_stop");
    step("stop answered", { status: stop.status });
    if (waitForRelayEnded) {
      step((await relayEnded) ? "call.conversation.ended arrived" : `call.conversation.ended did not arrive in ${RELAY_ENDED_TIMEOUT_MS} ms`);
    }
    const speakStarted = waitFor(call, "call.speak.started", SPEAK_ENDED_TIMEOUT_MS);
    const speakEnded = waitFor(call, "call.speak.ended", SPEAK_ENDED_TIMEOUT_MS);
    const speak = await command(call, "speak", speakBody(CLOSING_LINE));
    if (!speak.ok) return step("stopped: speak was refused. The call is still up: press h to hang up");
    step("speak answered", { status: speak.status });
    void speakStarted.then((payload) => payload && step("call.speak.started arrived"));
    const ended = await speakEnded;
    if (call.ended) return step("the call hung up before call.speak.ended");
    step(ended ? "call.speak.ended arrived" : `call.speak.ended did not arrive in ${SPEAK_ENDED_TIMEOUT_MS} ms`, { status: ended?.status });
    await command(call, "hangup");
    step("hangup answered");
  }

  function dropRelay(call: Call, clean: boolean): void {
    const relay = call.relay;
    if (!relay) return note(`${call.label} has no Relay connection to drop.`);
    relay.closedByUs = true;
    if (clean) relay.socket.close(1000, "spike");
    else relay.socket.terminate();
  }

  function marker(call: Call): void {
    call.markers += 1;
    record("marker", {
      call: call.label,
      call_ms: Date.now() - call.arrivedAt,
      n: call.markers,
      final_prompts_since_last_marker: call.finalPrompts - call.finalPromptsAtLastMarker,
    });
    call.finalPromptsAtLastMarker = call.finalPrompts;
  }

  function help(): void {
    for (const [key, what] of KEYS) print(`  ${key}  ${what}`);
    print("  Q  hang up any call that is still up, and quit (Ctrl-C does the same)");
  }

  function press(key: string): void {
    if (key === "?") return help();
    const what = KEYS.find(([known]) => known === key)?.[1];
    if (what === undefined) return;
    const call = currentCall();
    record("key", { key, action: what, ...callFields(call) });
    if (!call) return print("No call is up. Dial the number first.");
    const run = (work: Promise<unknown>) => void work.catch((error: Error) => record("error", { where: `key ${key}`, error: error.message }));
    switch (key) {
      case "l":
        return send(call, textFrame(LONG_REPLY), "key l: long reply");
      case "q":
        send(call, textFrame(LONG_REPLY), "key q: long reply");
        return send(call, textFrame(QUEUED_REPLY), "key q: queued reply");
      case "g":
        return send(call, textFrame(GREETING), "key g: greeting again");
      case "m":
        return marker(call);
      case "s":
        return run(command(call, "conversation_relay_stop"));
      case "e":
        return send(call, { type: "end", handoffData: JSON.stringify({ reason: "spike_end_key" }) }, "key e: end frame");
      case "d":
        return dropRelay(call, false);
      case "D":
        return dropRelay(call, true);
      case "k":
        return run(command(call, "speak", speakBody(SPEAK_LINE)));
      case "c":
        return run(closingSequence(call, false));
      case "C":
        return run(closingSequence(call, true));
      case "h":
        return run(command(call, "hangup"));
    }
  }

  // ---- The server

  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "POST" && path === WEBHOOK_PATH) {
      onWebhook(req, res).catch((error: Error) => {
        record("error", { where: "webhook", error: error.message });
        if (!res.headersSent) res.writeHead(500).end();
      });
      return;
    }
    record("http.other", { method: req.method, url: req.url, headers: req.headers });
    req.resume();
    res.writeHead(path === "/" ? 200 : 404, { "content-type": "text/plain" }).end("telnyx relay spike\n");
  });
  server.on("upgrade", (req, socket, head) => {
    try {
      onUpgrade(req, socket, head);
    } catch (error) {
      record("error", { where: "relay handshake", error: (error as Error).message });
      socket.destroy();
    }
  });
  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(config.port, ready);
  });
  const port = (server.address() as AddressInfo).port;

  const allowedShown = config.allowedCallers.length > 0 ? log.mask(config.allowedCallers).join(", ") : "";
  log.write("start", {
    webhook_url: `${config.publicBaseUrl}${WEBHOOK_PATH}`,
    relay_url: `${relayBase}<token>`,
    telnyx_base_url: config.telnyxBaseUrl,
    port,
    voice: config.voice,
    speak_voice: config.speakVoice,
    stt_engine: config.sttEngine,
    stt_model: config.sttModel,
    language: config.language,
    interruptible: config.interruptible,
    greeting_delay_ms: config.greetingDelayMs,
    start_extra: config.startExtra,
    allowed_callers: config.allowedCallers,
    node: process.version,
  });
  print("Telnyx Conversation Relay spike: fixed replies, no model.");
  print(`Webhooks:  POST ${config.publicBaseUrl}${WEBHOOK_PATH}`);
  print(`Listening: http://localhost:${port}`);
  print(`Relay:     ${relayBase}<single-use token>`);
  print(`Telnyx:    ${config.telnyxBaseUrl}`);
  print(`Log:       ${config.logPath}`);
  print(`Voice:     ${config.voice} (speak: ${config.speakVoice})`);
  print(`Hearing:   ${config.sttEngine} ${config.sttModel}, language ${config.language}, interruptible ${config.interruptible}`);
  print(
    allowedShown
      ? `Callers:   only ${allowedShown} is answered`
      : "Callers:   EVERY Caller is answered, because PHONE_ALLOWED_CALLERS is not set",
  );
  print("Keys (they act on the latest call that is still up):");
  help();

  return {
    port,
    press,
    async quit() {
      const up = [...calls.values()].filter((call) => !call.ended);
      if (up.length > 0) {
        note("Quitting: hanging up the call that is still up.");
        await Promise.race([
          Promise.all(up.map((call) => command(call, "hangup"))),
          new Promise((resolve) => setTimeout(resolve, 3000).unref()),
        ]);
      }
      log.write("quit");
      for (const call of calls.values()) call.relay?.socket.terminate();
      sockets.close();
      server.close();
      server.closeAllConnections();
    },
  };
}
