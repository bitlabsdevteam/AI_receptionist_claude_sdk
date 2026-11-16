import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CLOSING_LINE, GREETING, LONG_REPLY, SPEAK_LINE } from "./frames.js";

/**
 * The ticket's acceptance check. It runs the real program, as `npx tsx spikes/telnyx-relay/server.ts` does, with its
 * settings in a `.env` file and nothing real behind it: a local HTTP server stands in for the Telnyx API
 * (`TELNYX_BASE_URL`), the webhooks are made by hand and signed with a throwaway Ed25519 key, and a local WebSocket
 * client plays Telnyx's side of the Relay connection. It proves the wiring and the log. It proves nothing about what
 * the real Telnyx sends or does.
 */

const API_KEY = "KEY0123456789abcdefSECRETspike";
const CALLER = "+12025550133";
const CALLED = "+12025550131";
const STRANGER = "+13125550188";
const CALL = "v3:call-control-id-AAA";
const PUBLIC_BASE_URL = "https://spike.example.test";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url").toString("base64");

interface Command {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

interface StandIn {
  server: Server;
  url: string;
  commands: Command[];
}

interface Program {
  child: ChildProcessWithoutNullStreams;
  port: number;
  output: () => string;
  logPath: string;
  closed: Promise<number | null>;
}

let dir: string;
let telnyx: StandIn | undefined;
let program: Program | undefined;
let sockets: WebSocket[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spike-relay-"));
});
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets = [];
  if (program && program.child.exitCode === null) {
    program.child.kill("SIGKILL");
    await program.closed;
  }
  program = undefined;
  await new Promise<void>((done) => (telnyx ? telnyx.server.close(() => done()) : done()));
  telnyx = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function until<T>(what: string, check: () => T | undefined | false, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.\n${program?.output() ?? ""}`);
    await new Promise((tick) => setTimeout(tick, 10));
  }
}

/** Answers every Call Control command the way Telnyx's reference says it does. */
async function startTelnyxStandIn(): Promise<StandIn> {
  const commands: Command[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = req.url ?? "";
      commands.push({
        path,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>,
      });
      const data = path.endsWith("/conversation_relay_start")
        ? { result: "ok", conversation_relay_id: "d7e9c1d4-8b2a-4b8f-b3a7-9a671c9e9b0a" }
        : { result: "ok" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, commands };
}

function dotEnv(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${value}\n`)
    .join("");
}

/** Starts the program in a directory that holds only a `.env`, with an environment that holds only a PATH. */
async function startProgram(env: Record<string, string>): Promise<Program> {
  writeFileSync(join(dir, ".env"), dotEnv(env));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("spikes/telnyx-relay/server.ts")], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
    timeout: 30_000,
  });
  let output = "";
  child.stdout.on("data", (data: Buffer) => (output += data.toString()));
  child.stderr.on("data", (data: Buffer) => (output += data.toString()));
  const closed = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
  program = { child, port: 0, output: () => output, logPath: join(dir, "spike.jsonl"), closed };
  const port = await until("the program to say where it listens", () => /Listening: +http:\/\/localhost:(\d+)/.exec(output)?.[1]);
  program.port = Number(port);
  return program;
}

function settings(standIn: StandIn, extra: Record<string, string> = {}): Record<string, string> {
  return {
    TELNYX_API_KEY: API_KEY,
    TELNYX_PUBLIC_KEY: PUBLIC_KEY,
    PUBLIC_BASE_URL,
    TELNYX_BASE_URL: standIn.url,
    PHONE_ALLOWED_CALLERS: CALLER,
    PORT: "0",
    SPIKE_LOG_PATH: join(dir, "spike.jsonl"),
    ...extra,
  };
}

let eventCount = 0;
function event(eventType: string, payload: Record<string, unknown> = {}, id = `event-${++eventCount}`): string {
  return JSON.stringify({
    data: {
      record_type: "event",
      event_type: eventType,
      id,
      occurred_at: new Date().toISOString(),
      payload: {
        call_control_id: CALL,
        call_leg_id: "leg-1",
        call_session_id: "session-1",
        connection_id: "1240401930086254526",
        client_state: null,
        from: CALLER,
        to: CALLED,
        ...payload,
      },
    },
    meta: { attempt: 1, delivered_to: `${PUBLIC_BASE_URL}/telnyx/webhooks` },
  });
}

/** Posts a webhook the way Telnyx does: the raw body, signed over `<timestamp>|<body>`. */
async function deliver(body: string, signed = true): Promise<number> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "telnyx-webhooks" };
  if (signed) {
    headers["telnyx-timestamp"] = timestamp;
    headers["telnyx-signature-ed25519"] = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64");
  }
  const response = await fetch(`http://127.0.0.1:${program!.port}/telnyx/webhooks`, { method: "POST", headers, body });
  return response.status;
}

function commandNames(standIn: StandIn): string[] {
  return standIn.commands.map((command) => command.path.split("/actions/")[1] ?? command.path);
}

function command(standIn: StandIn, name: string): Promise<Command> {
  return until(`the ${name} command`, () => standIn.commands.find((sent) => sent.path.endsWith(`/actions/${name}`)));
}

interface Relay {
  socket: WebSocket;
  frames: Array<Record<string, unknown>>;
  frame: (index: number) => Promise<Record<string, unknown>>;
  closed: Promise<number>;
}

/** Connects the way Telnyx would: to the address the Relay was started with, here on the local port. */
function connectRelay(relayUrl: string): Promise<Relay> {
  const local = `ws://127.0.0.1:${program!.port}${new URL(relayUrl).pathname}`;
  const socket = new WebSocket(local, { headers: { "x-handshake-check": "seen-in-the-log" } });
  sockets.push(socket);
  const frames: Array<Record<string, unknown>> = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
  const closed = new Promise<number>((done) => socket.on("close", (code) => done(code)));
  const relay: Relay = { socket, frames, frame: (index) => until(`Relay frame ${index}`, () => frames[index]), closed };
  return new Promise((opened, refused) => {
    socket.on("open", () => opened(relay));
    socket.on("unexpected-response", (_request, response) => refused(new Error(`refused with ${response.statusCode}`)));
    socket.on("error", refused);
  });
}

function logLines(): Array<Record<string, unknown>> {
  return readFileSync(program!.logPath, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Answers the call and brings the Relay up to its greeting. */
async function callUntilGreeting(standIn: StandIn): Promise<Relay> {
  expect(await deliver(event("call.initiated", { direction: "incoming", state: "parked", caller_id_name: "Jane Example" }))).toBe(200);
  await command(standIn, "answer");
  expect(await deliver(event("call.answered"))).toBe(200);
  const start = await command(standIn, "conversation_relay_start");
  const relay = await connectRelay(start.body.url as string);
  relay.socket.send(
    JSON.stringify({
      type: "setup",
      sessionId: "relay-session-1",
      callControlId: CALL,
      callSessionId: "session-1",
      callLegId: "leg-1",
      from: CALLER,
      to: CALLED,
      direction: "inbound",
      callerName: "Jane Example",
      callStatus: "active",
      customParameters: {},
    }),
  );
  expect(await relay.frame(0)).toEqual({ type: "text", token: GREETING, last: true });
  return relay;
}

describe("the spike program at startup", () => {
  it("names every missing variable and exits 1", async () => {
    writeFileSync(join(dir, ".env"), "");
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("spikes/telnyx-relay/server.ts")], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      timeout: 30_000,
    });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
    const code = await new Promise<number | null>((done) => child.on("close", done));

    expect(code).toBe(1);
    expect(stderr).toContain("TELNYX_API_KEY is not set");
    expect(stderr).toContain("TELNYX_PUBLIC_KEY is not set");
    expect(stderr).toContain("PUBLIC_BASE_URL is not set");
  });

  it("prints the address to expect webhooks on, from the values in .env", async () => {
    telnyx = await startTelnyxStandIn();
    const { output } = await startProgram(settings(telnyx));

    await until("the webhook address", () => output().includes(`Webhooks:  POST ${PUBLIC_BASE_URL}/telnyx/webhooks`));
    expect(output()).toContain("Telnyx.Ultra.Callie");
    expect(output()).toContain("Deepgram deepgram/nova-3");
  });
});

describe("the spike program on a call", () => {
  it("answers a signed call, starts the Relay, replies with fixed text and logs every event", async () => {
    telnyx = await startTelnyxStandIn();
    await startProgram(settings(telnyx));

    const relay = await callUntilGreeting(telnyx);

    // The answer and the Relay start are as the spec's Configuration table says.
    const answer = await command(telnyx, "answer");
    expect(answer.path).toBe(`/v2/calls/${CALL}/actions/answer`);
    expect(answer.authorization).toBe(`Bearer ${API_KEY}`);
    const start = await command(telnyx, "conversation_relay_start");
    expect(start.body).toMatchObject({
      voice: "Telnyx.Ultra.Callie",
      language: "en",
      transcription_engine: "Deepgram",
      transcription_engine_config: { transcription_model: "deepgram/nova-3" },
      interruptible: "speech",
    });
    expect(start.body.url).toMatch(/^wss:\/\/spike\.example\.test\/telnyx\/relay\/[A-Za-z0-9_-]{20,}$/);
    expect(start.body).not.toHaveProperty("greeting");

    // An echo of what Telnyx heard, and only of a final prompt.
    relay.socket.send(JSON.stringify({ type: "prompt", voicePrompt: "what are your", lang: "en", last: false }));
    relay.socket.send(JSON.stringify({ type: "prompt", voicePrompt: "what are your opening hours", lang: "en", last: true }));
    expect(await relay.frame(1)).toEqual({ type: "text", token: "You said: what are your opening hours", last: true });

    // The long reply, on a key press.
    program!.child.stdin.write("l");
    expect(await relay.frame(2)).toEqual({ type: "text", token: LONG_REPLY, last: true });
    relay.socket.send(JSON.stringify({ type: "interrupt", utteranceUntilInterrupt: "This is the long", durationUntilInterruptMs: 900 }));

    // The closing sequence: stop the Relay, speak, wait for call.speak.ended, hang up.
    program!.child.stdin.write("c");
    await command(telnyx, "conversation_relay_stop");
    const speak = await command(telnyx, "speak");
    expect(speak.body).toMatchObject({ payload: CLOSING_LINE, voice: "Telnyx.Ultra.Callie" });
    expect(await deliver(event("call.conversation.ended", { reason: "stopped" }))).toBe(200);
    expect(await deliver(event("call.speak.started"))).toBe(200);
    await new Promise((tick) => setTimeout(tick, 100));
    expect(commandNames(telnyx)).not.toContain("hangup");
    expect(await deliver(event("call.speak.ended", { status: "completed" }))).toBe(200);
    await command(telnyx, "hangup");
    expect(await deliver(event("call.hangup", { hangup_cause: "normal_clearing", hangup_source: "callee" }))).toBe(200);
    expect(commandNames(telnyx)).toEqual(["answer", "conversation_relay_start", "conversation_relay_stop", "speak", "hangup"]);

    // Every webhook, frame, command and response is in the log, each with a millisecond timestamp.
    const lines = await until("the hangup webhook in the log", () => {
      const all = logLines();
      return all.some((line) => line.event_type === "call.hangup") && all;
    });
    for (const line of lines) {
      expect(line.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(Number.isInteger(line.t_ms)).toBe(true);
    }
    expect(lines.filter((line) => line.kind === "webhook").map((line) => line.event_type)).toEqual([
      "call.initiated",
      "call.answered",
      "call.conversation.ended",
      "call.speak.started",
      "call.speak.ended",
      "call.hangup",
    ]);
    expect(lines.filter((line) => line.kind === "webhook").every((line) => line.signature === "valid")).toBe(true);
    const sent = lines.filter((line) => line.kind === "command");
    expect(sent.map((line) => line.name)).toEqual(commandNames(telnyx));
    const responses = lines.filter((line) => line.kind === "command.response");
    expect(responses.map((line) => [line.name, line.status])).toEqual(sent.map((line) => [line.name, 200]));
    expect(responses[1]?.body).toEqual({ data: { result: "ok", conversation_relay_id: "d7e9c1d4-8b2a-4b8f-b3a7-9a671c9e9b0a" } });
    expect(lines.filter((line) => line.kind === "relay.in").map((line) => line.type)).toEqual([
      "setup",
      "prompt",
      "prompt",
      "interrupt",
    ]);
    expect(lines.filter((line) => line.kind === "relay.out").map((line) => (line.frame as { token: string }).token)).toEqual([
      GREETING,
      "You said: what are your opening hours",
      LONG_REPLY,
    ]);
    expect(lines.filter((line) => line.kind === "key").map((line) => line.key)).toEqual(["l", "c"]);

    // The handshake's headers are logged in full, and the handshake is reported as unsigned.
    const handshake = lines.find((line) => line.kind === "relay.handshake");
    expect(handshake).toMatchObject({ token: "accepted", signature: "absent" });
    expect(handshake?.headers).toMatchObject({
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "x-handshake-check": "seen-in-the-log",
    });
    expect(Object.keys(handshake?.headers as object)).toContain("sec-websocket-key");

    // The time from the call arriving to the Relay's setup is in the log.
    const setup = lines.find((line) => line.kind === "relay.in" && line.type === "setup");
    expect(typeof setup?.ms_since_call_arrived).toBe("number");
    expect(setup?.matches_call).toBe(true);
  });

  it("writes no key and no full phone number to the log or the terminal", async () => {
    telnyx = await startTelnyxStandIn();
    const { output } = await startProgram(settings(telnyx));
    const relay = await callUntilGreeting(telnyx);
    relay.socket.send(JSON.stringify({ type: "prompt", voicePrompt: "call me back on 202 555 0133", lang: "en", last: true }));
    await relay.frame(1);
    // A stranger's call and an unsigned webhook are logged too.
    await deliver(event("call.initiated", { direction: "incoming", from: STRANGER, call_control_id: "v3:other" }));
    await deliver(event("call.initiated", { direction: "incoming", from: STRANGER }), false);
    program!.child.stdin.write("h");
    await command(telnyx, "hangup");
    await until("the hangup response in the log", () => logLines().some((line) => line.kind === "command.response" && line.name === "hangup"));

    const written = readFileSync(program!.logPath, "utf8") + output();
    expect(written).toContain("***0133");
    expect(written).toContain("***0188");
    expect(written).not.toContain(API_KEY);
    expect(written).not.toContain("Bearer");
    for (const number of [CALLER, CALLED, STRANGER]) {
      const digits = number.slice(1);
      expect(written).not.toContain(digits);
      expect(written).not.toContain(digits.slice(1));
    }
    expect(written).not.toMatch(/202[\s().-]*555[\s().-]*01/);
    expect(written).not.toMatch(/\+\d{7,}/);
    expect(written).not.toContain("Jane Example");
  });

  it("refuses a webhook that is not signed, and does nothing with it", async () => {
    telnyx = await startTelnyxStandIn();
    await startProgram(settings(telnyx));

    expect(await deliver(event("call.initiated", { direction: "incoming" }), false)).toBe(401);
    await new Promise((tick) => setTimeout(tick, 150));

    expect(telnyx.commands).toEqual([]);
    expect(logLines().find((line) => line.kind === "webhook.rejected")).toMatchObject({
      reason: "telnyx-timestamp header is missing",
    });
  });

  it("rejects a Caller who is not on the allowed list, unanswered", async () => {
    telnyx = await startTelnyxStandIn();
    await startProgram(settings(telnyx));

    expect(await deliver(event("call.initiated", { direction: "incoming", from: STRANGER }))).toBe(200);
    const reject = await command(telnyx, "reject");

    expect(reject.body).toMatchObject({ cause: "CALL_REJECTED" });
    expect(commandNames(telnyx)).toEqual(["reject"]);
  });

  it("acts once on a webhook that is delivered twice, and logs the second as a duplicate", async () => {
    telnyx = await startTelnyxStandIn();
    await startProgram(settings(telnyx));
    const initiated = event("call.initiated", { direction: "incoming" }, "same-id");

    expect(await deliver(initiated)).toBe(200);
    expect(await deliver(initiated)).toBe(200);
    await until("both deliveries in the log", () => logLines().filter((line) => line.kind === "webhook").length === 2);
    await new Promise((tick) => setTimeout(tick, 100));

    expect(commandNames(telnyx)).toEqual(["answer"]);
    expect(logLines().filter((line) => line.kind === "webhook").map((line) => line.duplicate)).toEqual([false, true]);
  });

  it("lets a Relay token be used once, and refuses a token it never issued", async () => {
    telnyx = await startTelnyxStandIn();
    await startProgram(settings(telnyx));
    await callUntilGreeting(telnyx);
    const start = await command(telnyx, "conversation_relay_start");

    await expect(connectRelay(start.body.url as string)).rejects.toThrow("refused with 401");
    await expect(connectRelay(`${PUBLIC_BASE_URL}/telnyx/relay/never-issued`)).rejects.toThrow("refused with 401");

    expect(logLines().filter((line) => line.kind === "relay.handshake").map((line) => line.token)).toEqual([
      "accepted",
      "used",
      "unknown",
    ]);
  });

  it("drops the Relay connection on a key press, and can still send speak afterwards", async () => {
    telnyx = await startTelnyxStandIn();
    await startProgram(settings(telnyx, { TELNYX_TTS_VOICE: "Telnyx.KokoroTTS.af", TELNYX_STT_ENGINE: "Telnyx", TELNYX_STT_MODEL: "openai/whisper-large-v3-turbo" }));
    const relay = await callUntilGreeting(telnyx);
    expect((await command(telnyx, "conversation_relay_start")).body).toMatchObject({
      voice: "Telnyx.KokoroTTS.af",
      transcription_engine: "Telnyx",
      transcription_engine_config: { transcription_model: "openai/whisper-large-v3-turbo" },
    });

    program!.child.stdin.write("d");
    expect(await relay.closed).toBe(1006);
    program!.child.stdin.write("k");
    const speak = await command(telnyx, "speak");

    expect(speak.body).toMatchObject({ payload: SPEAK_LINE, voice: "Telnyx.KokoroTTS.af" });
    expect(logLines().find((line) => line.kind === "relay.close")).toMatchObject({ by: "us" });
  });

  it("takes extra Relay settings from the environment, and can leave the model out", async () => {
    telnyx = await startTelnyxStandIn();
    await startProgram(
      settings(telnyx, {
        TELNYX_STT_ENGINE: "Google",
        TELNYX_STT_MODEL: "none",
        VOICE_LANGUAGE: "en-US",
        SPIKE_INTERRUPTIBLE: "any",
        SPIKE_START_EXTRA_JSON: `'{"greeting":"Hi.","transcription_engine_config":{"interim_results":true}}'`,
      }),
    );
    await deliver(event("call.initiated", { direction: "incoming" }));
    await deliver(event("call.answered"));

    const start = await command(telnyx, "conversation_relay_start");

    expect(start.body).toMatchObject({ transcription_engine: "Google", language: "en-US", interruptible: "any", greeting: "Hi." });
    expect(start.body.transcription_engine_config).toEqual({ interim_results: true });
  });

  it("hangs up the call it is on when it is told to quit", async () => {
    telnyx = await startTelnyxStandIn();
    const { child, closed } = await startProgram(settings(telnyx));
    await callUntilGreeting(telnyx);

    child.kill("SIGINT");

    expect(await closed).toBe(0);
    expect(commandNames(telnyx)).toContain("hangup");
    expect(existsSync(program!.logPath)).toBe(true);
  });

  it("quits the same way on the Q key, which also works when the keys are piped in", async () => {
    telnyx = await startTelnyxStandIn();
    const { child, closed } = await startProgram(settings(telnyx));
    await callUntilGreeting(telnyx);

    child.stdin.write("Q");

    expect(await closed).toBe(0);
    expect(commandNames(telnyx)).toContain("hangup");
  });
});
