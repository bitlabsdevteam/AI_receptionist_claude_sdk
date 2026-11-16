import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { FlowEngine } from "../engine/engine.js";
import { RELAY_PATH, WEBHOOK_PATH, type PhoneConfig } from "../phone-config.js";
import type { TelnyxClient } from "../telnyx/client.js";
import { parseWebhookEvent, type CallArrived, type TelnyxEvent } from "../telnyx/events.js";
import { parseRelayFrame } from "../telnyx/frames.js";
import { RelayTokens } from "../telnyx/relay-tokens.js";
import { checkWebhookSignature } from "../telnyx/signature.js";
import { messageOf } from "./chat.js";
import { PhoneCalls, shownNumber, type PhoneOptions } from "./phone.js";
import { TelnyxPhoneLine } from "./telnyx-phone-line.js";

/** A webhook body is a few KB. A body past this is refused without being read to the end. */
const MAX_BODY_BYTES = 1 << 20;
/** The ids of the most recent events that are remembered, to tell a repeated delivery. */
const REMEMBERED_EVENTS = 5000;
/** The most a frame on the Relay connection may hold. */
const MAX_FRAME_BYTES = 1 << 20;

export interface PhoneServerOptions {
  config: PhoneConfig;
  engine: FlowEngine;
  client: TelnyxClient;
  /** Prints a line for whoever is at the terminal. Plain output, not a Trace. Never given a key. */
  write: (text: string) => void;
  /** The time in ms since the epoch, for the freshness of a webhook's signature and the life of a Relay token. */
  now?: () => number;
  /** The rules' timers and clock. See `PhoneOptions`. */
  rules?: PhoneOptions;
}

export interface PhoneServer {
  /** The port it listens on (the real one, when `0` was asked for). */
  port: number;
  /** Hangs up every Call that is in progress. It returns when Telnyx has been told. */
  hangUpAll(): Promise<number>;
  /** Stops listening and drops every connection. */
  close(): Promise<void>;
}

/**
 * The phone program's server: plain `node:http` for Telnyx's webhooks and, on the same port, the Relay connection (a
 * WebSocket from Telnyx). It is the one place that joins the rules of a phone Call (`PhoneCalls`) to Telnyx: it
 * decides who may be answered, answers, starts the Relay with a single-use token, and passes what happens on the
 * line to the rules.
 *
 * A webhook is acknowledged as soon as its signature has been checked, and acted on afterwards. Telnyx may deliver an
 * event twice, late or out of order, so each event is read as a report that may no longer be true: one for a Call that
 * is not on the line, or is over, is noted and nothing more.
 */
export async function startPhoneServer(options: PhoneServerOptions, listenOn = options.config.port): Promise<PhoneServer> {
  const { config, client, write } = options;
  const now = options.now ?? Date.now;
  const tokens = new RelayTokens(now);
  const line = new TelnyxPhoneLine(client, config, write);
  const phone = new PhoneCalls(options.engine, line, write, options.rules);

  /** Calls known to be over, so a late event cannot bring one back. Only ids are kept. */
  const over = new Set<string>();
  /** The Calls that have been told to start the Relay. */
  const relayStarted = new Set<string>();
  const seenEvents = new Set<string>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const sockets = new Set<WebSocket>();

  /** Ends everything this server keeps for a Call. */
  function finish(callId: string): void {
    over.add(callId);
    relayStarted.delete(callId);
    tokens.forget(callId);
    line.close(callId);
  }

  function remembered(eventId: string): boolean {
    if (seenEvents.has(eventId)) return true;
    seenEvents.add(eventId);
    if (seenEvents.size > REMEMBERED_EVENTS) seenEvents.delete(seenEvents.values().next().value!);
    return false;
  }

  async function onArrived(event: CallArrived): Promise<void> {
    const id = event.callSessionId;
    if (over.has(id)) return write("(Ignored an arrival for a Call that is already over.)\n");
    if (line.has(id)) return write("(Ignored an arrival for a Call that is already known.)\n");
    if (event.direction !== "inbound") return write("(Ignored a call that is not an inbound call.)\n");

    if (config.allowedCallers && (event.from === undefined || !config.allowedCallers.has(event.from))) {
      over.add(id);
      write(`Rejected a call from ${shownNumber(event.from)}: it is not on the list of allowed Callers.\n`);
      try {
        await client.reject(event.callControlId);
      } catch (error) {
        write(`(Could not reject the call: ${messageOf(error)})\n`);
      }
      return;
    }

    line.open(id, event.callControlId);
    phone.callArrived(id, event.from);
    try {
      await client.answer(event.callControlId);
    } catch (error) {
      // The Call never got going, so there is no one to say a closing to: it ends as if the Caller had gone.
      write(`(Could not answer the call: ${messageOf(error)})\n`);
      phone.callerHungUp(id);
      finish(id);
    }
  }

  async function onAnswered(callId: string): Promise<void> {
    const callControlId = line.callControlIdOf(callId);
    if (callControlId === undefined) return write("(Ignored an answered event for an unknown Call.)\n");
    if (relayStarted.has(callId)) return write("(Ignored an answered event: the Call already has a Relay.)\n");
    relayStarted.add(callId);
    const token = tokens.issue(callId);
    try {
      await client.startRelay(callControlId, {
        url: `${config.relayBase}${RELAY_PATH}${token}`,
        voice: config.voice,
        sttEngine: config.sttEngine,
        sttModel: config.sttModel,
        language: config.language,
      });
    } catch (error) {
      write(`(Could not start the Relay: ${messageOf(error)})\n`);
      phone.connectionLost(callId);
    }
  }

  async function onEvent(event: TelnyxEvent): Promise<void> {
    if (event.kind === "malformed") return write(`(Ignored a webhook: ${event.reason}.)\n`);
    if (event.kind === "ignored") return;
    if (remembered(event.eventId)) return write("(Ignored a repeated event.)\n");

    switch (event.kind) {
      case "arrived":
        return onArrived(event);
      case "answered":
        return onAnswered(event.callSessionId);
      case "hungUp": {
        const id = event.callSessionId;
        if (line.has(id)) phone.callerHungUp(id);
        else if (!over.has(id)) write("(Ignored a hang-up for an unknown Call.)\n");
        return finish(id);
      }
      case "speechEnded": {
        const id = event.callSessionId;
        if (!line.has(id)) return write("(Ignored a speech ended event for an unknown Call.)\n");
        const outcome = await line.speechEnded(id, event.status);
        if (outcome === "not-closing") return write("(Ignored a speech ended event: the Call is not being closed.)\n");
        if (outcome === "hung-up") {
          phone.closingSpoken(id);
          finish(id);
        }
        return;
      }
      case "relayEnded":
        // Our side of the Relay connection closing is reported by the connection itself.
        return;
    }
  }

  function handleWebhook(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        if (!tooBig) {
          tooBig = true;
          res.writeHead(413, { connection: "close" });
          res.end();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooBig) return;
      const rawBody = Buffer.concat(chunks);
      const check = checkWebhookSignature({ rawBody, headers: req.headers, publicKey: config.publicKey, nowMs: now() });
      if (!check.ok) {
        write(`Refused a webhook: ${check.reason}.\n`);
        res.writeHead(401);
        res.end();
        return;
      }
      // Acknowledge now: whatever the event leads to runs after Telnyx has its answer.
      res.writeHead(200);
      res.end();
      const event = parseWebhookEvent(rawBody);
      setImmediate(() => {
        onEvent(event).catch((error: unknown) => write(`(Could not handle a webhook: ${messageOf(error)})\n`));
      });
    });
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== WEBHOOK_PATH) {
      res.writeHead(404);
      res.end();
    } else if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
    } else {
      handleWebhook(req, res);
    }
  });

  /** Refuses a connection that asked to become a WebSocket, with an HTTP answer. */
  function refuse(socket: Duplex, status: 401 | 404): void {
    socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Not Found"}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  }

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => undefined);
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (!path.startsWith(RELAY_PATH)) return refuse(socket, 404);
    const callId = tokens.redeem(path.slice(RELAY_PATH.length));
    if (callId === undefined || !line.has(callId)) {
      write("Refused a Relay connection: its token is not valid.\n");
      return refuse(socket, 401);
    }
    wss.handleUpgrade(req, socket, head, (ws) => joinRelay(ws, callId));
  });

  /**
   * A Relay connection with a good token. It is the Call's only when its first frame, the `setup`, names that Call.
   * Whatever else it does ends it, and the Call with it, since a Call that never gets its Relay cannot go on.
   */
  function joinRelay(ws: WebSocket, callId: string): void {
    sockets.add(ws);
    let joined = false;
    ws.on("error", () => undefined);
    ws.on("close", () => {
      sockets.delete(ws);
      // The rules ignore this for a Call that is being closed or is over, as it is when we hang up.
      phone.connectionLost(callId);
    });
    ws.on("message", (data: RawData) => {
      const frame = parseRelayFrame(rawText(data));
      if (!joined) {
        const callControlId = line.callControlIdOf(callId);
        if (frame.kind !== "setup" || frame.callSessionId !== callId || frame.callControlId !== callControlId) {
          write("Refused a Relay connection: it did not name this Call in its setup.\n");
          ws.close(1008, "setup does not name this Call");
          return;
        }
        joined = true;
        line.attach(callId, ws);
        phone.lineConnected(callId);
        return;
      }
      switch (frame.kind) {
        case "utterance":
          return phone.callerSaid(callId, frame.text);
        case "interrupt":
          return phone.callerInterrupted(callId);
        case "error":
          return write(`(Telnyx reported a problem on the Relay connection: ${frame.description || "no description"})\n`);
        case "malformed":
          return write(`(Ignored a Relay message: ${frame.reason}.)\n`);
        default:
          // Partial prompts, keypad presses and frames of types nothing here uses.
          return;
      }
    });
  }

  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    // On this machine only: ngrok reaches it from here, and nothing else on the network should.
    server.listen(listenOn, "127.0.0.1", () => {
      server.off("error", failed);
      ready();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : listenOn;

  return {
    port,
    async hangUpAll() {
      const inProgress = line.calls();
      await Promise.all(
        inProgress.map(async (id) => {
          const callControlId = line.callControlIdOf(id);
          if (callControlId === undefined) return;
          try {
            await client.hangup(callControlId);
          } catch (error) {
            write(`(Could not hang up: ${messageOf(error)})\n`);
          }
        }),
      );
      return inProgress.length;
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    },
  };
}

/** A message from the Relay connection as text. */
function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}
