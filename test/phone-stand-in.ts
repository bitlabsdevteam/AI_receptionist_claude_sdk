import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { transitionToolName } from "../src/engine/run-node.js";
import { finish, messageStart, sseBody, textBlock, toolBlock, type Json } from "./sse.js";

/**
 * What the phone program talks to, played by this machine: one throwaway HTTP server stands in for Anthropic and the
 * Telnyx API (it records every command it is sent), and the helpers here play Telnyx's other sides, which are the
 * signed webhooks it posts and the Relay connection it opens. Nothing here reaches the network, starts ngrok or places
 * a call. The Ed25519 key pair is made for each test run and is nobody's.
 */

export const GREETING = "Hello, this is Ava from Acme Co.";
export const HELP_REPLY = "Happy to help with that.";
export const GOODBYE_MESSAGE = "Thank you for calling. Goodbye.";

export const CALLER = "+12025550133";
export const CALL_SESSION_ID = "428c31b6-abf3-3bc1-b7f4-5013ef9657c1";
export const CALL_CONTROL_ID = "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg";

/** What the stand-in saw, in the order it saw it: a command sent to the Telnyx API, or a frame the Relay connection got. */
export type Seen =
  | { kind: "command"; callControlId: string; command: string; body: Json; authorization: string | undefined }
  | { kind: "frame"; frame: Json };

export interface StandIn {
  server: Server;
  url: string;
  /** Everything seen, in order. The helpers push the Relay frames onto it too, so the order of both can be asserted. */
  seen: Seen[];
  /** Only the commands, as `command` names. */
  commands(): string[];
  /** The bodies of the requests to the model. */
  model: Json[];
  /** Holds the response to every command until the returned function is called. For testing that a webhook is answered at once. */
  hold(): () => void;
  /** The public key, in the form the Telnyx portal shows it. */
  publicKey: string;
  privateKey: KeyObject;
}

/**
 * The model greets when no tools are offered. When tools are offered it takes the goodbye Edge if the Caller's last
 * words include "bye", and otherwise replies `HELP_REPLY`.
 */
export async function startStandIn(): Promise<StandIn> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const seen: Seen[] = [];
  const model: Json[] = [];
  let held: Promise<void> | undefined;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const path = req.url ?? "";
      const command = /^\/v2\/calls\/([^/]+)\/actions\/([a-z_]+)$/.exec(path);
      if (command) {
        seen.push({
          kind: "command",
          callControlId: decodeURIComponent(command[1]!),
          command: command[2]!,
          body: JSON.parse(raw) as Json,
          authorization: req.headers.authorization,
        });
        void (held ?? Promise.resolve()).then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { result: "ok" } }));
        });
        return;
      }
      const body = JSON.parse(raw) as Json;
      model.push(body);
      const lastWords = JSON.stringify((body.messages as Json[]).at(-1));
      const events = !body.tools
        ? [messageStart, ...textBlock(0, ...GREETING.split(/(?<= )/)), ...finish("end_turn")]
        : lastWords.includes("bye")
          ? [messageStart, ...toolBlock(0, transitionToolName({ id: "e_start_goodbye" }), '{"reason":"done"}'), ...finish("tool_use")]
          : [messageStart, ...textBlock(0, ...HELP_REPLY.split(/(?<= )/)), ...finish("end_turn")];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sseBody(events));
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));

  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    commands: () => seen.filter((s) => s.kind === "command").map((s) => s.command),
    model,
    hold() {
      let release!: () => void;
      held = new Promise<void>((resolve) => (release = resolve));
      return release;
    },
    publicKey: Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64"),
    privateKey,
  };
}

/** The commands of one kind, in order. */
export function commandsOf(standIn: StandIn, command: string): Array<Extract<Seen, { kind: "command" }>> {
  return standIn.seen.filter((s): s is Extract<Seen, { kind: "command" }> => s.kind === "command" && s.command === command);
}

let eventCount = 0;

/** A version 2 webhook body in the shape of Telnyx's examples. */
export function webhookBody(eventType: string, payload: Json, id = `event-${++eventCount}`): string {
  return JSON.stringify({
    data: {
      record_type: "event",
      event_type: eventType,
      id,
      occurred_at: new Date().toISOString(),
      payload: { call_control_id: CALL_CONTROL_ID, call_session_id: CALL_SESSION_ID, ...payload },
    },
    meta: { attempt: 1 },
  });
}

export const initiated = (from = CALLER, id?: string) =>
  webhookBody("call.initiated", { from, to: "+12025550131", direction: "incoming", state: "parked" }, id);
export const answered = (id?: string) => webhookBody("call.answered", { state: "answered" }, id);
export const speakEnded = (id?: string) => webhookBody("call.speak.ended", { status: "completed" }, id);
export const hangup = (id?: string) => webhookBody("call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" }, id);

export interface PostOptions {
  /** Signs with this key instead of the account's, which makes the signature wrong. */
  signWith?: KeyObject;
  /** Sends no signature headers at all. */
  unsigned?: boolean;
  /** The timestamp, in seconds. Defaults to now. */
  timestamp?: number;
}

/** Posts a webhook to the program, signed as Telnyx signs it unless told otherwise. Resolves with the HTTP status. */
export async function postWebhook(port: number, standIn: StandIn, body: string, options: PostOptions = {}): Promise<number> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!options.unsigned) {
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    headers["telnyx-timestamp"] = timestamp;
    headers["telnyx-signature-ed25519"] = sign(null, Buffer.from(`${timestamp}|${body}`), options.signWith ?? standIn.privateKey).toString("base64");
  }
  const response = await fetch(`http://127.0.0.1:${port}/telnyx/webhooks`, { method: "POST", headers, body });
  await response.arrayBuffer();
  return response.status;
}

/** Waits until `check` returns a value, polling, and fails with `what` after 5 s. */
export async function until<T>(what: string, check: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The path (with its token) Telnyx was told to connect the Relay to, from the `conversation_relay_start` command. */
export function relayPathOf(standIn: StandIn): string {
  const start = commandsOf(standIn, "conversation_relay_start").at(-1);
  return new URL(String(start?.body.url).replace(/^wss:/, "https:")).pathname;
}

/** Telnyx's `setup` frame for a Relay connection, as the guide's example shows it. */
export function setupFrame(callSessionId = CALL_SESSION_ID, callControlId = CALL_CONTROL_ID): string {
  return JSON.stringify({
    type: "setup",
    sessionId: "relay-session-1",
    callSid: callControlId,
    callControlId,
    callSessionId,
    from: CALLER,
    to: "+12025550131",
    direction: "inbound",
  });
}

export const promptFrame = (text: string): string => JSON.stringify({ type: "prompt", voicePrompt: text, lang: "en", last: true });

/** A Relay connection from Telnyx's side. Every message the program sends is recorded on the stand-in's `seen`, in order. */
export class RelayClient {
  readonly socket: WebSocket;
  readonly frames: Json[] = [];
  closed: { code: number; reason: string } | undefined;
  /** Set when the program refused the upgrade (its HTTP status). */
  refusedWith: number | undefined;
  opened: Promise<boolean>;

  constructor(port: number, path: string, standIn: StandIn) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    this.socket.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Json;
      this.frames.push(frame);
      standIn.seen.push({ kind: "frame", frame });
    });
    this.socket.on("close", (code: number, reason: Buffer) => (this.closed = { code, reason: reason.toString() }));
    this.socket.on("unexpected-response", (_req, res) => {
      this.refusedWith = res.statusCode;
      res.resume();
    });
    this.socket.on("error", () => undefined);
    this.opened = new Promise<boolean>((resolve) => {
      this.socket.on("open", () => resolve(true));
      this.socket.on("error", () => resolve(false));
      this.socket.on("close", () => resolve(false));
      this.socket.on("unexpected-response", () => resolve(false));
    });
  }

  send(text: string): void {
    this.socket.send(text);
  }

  async done(): Promise<void> {
    await until("the Relay connection to end", () => this.closed !== undefined || this.refusedWith !== undefined);
  }

  close(): void {
    this.socket.terminate();
  }
}

/** A plain HTTP request that is not a webhook, for the paths the program does not serve. */
export function get(port: number, path: string, method = "GET"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}
