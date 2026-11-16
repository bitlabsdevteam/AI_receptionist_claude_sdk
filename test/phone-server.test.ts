import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TIME_LIMIT_LINE, TIME_LIMIT_MS } from "../src/adapters/phone.js";
import { startPhoneServer, type PhoneServer } from "../src/adapters/phone-server.js";
import { FlowEngine } from "../src/engine/engine.js";
import { loadFlow } from "../src/flow/load.js";
import type { Flow } from "../src/flow/schema.js";
import { readPhoneConfig, type PhoneConfig } from "../src/phone-config.js";
import { TelnyxClient } from "../src/telnyx/client.js";
import { RELAY_TOKEN_TTL_MS } from "../src/telnyx/relay-tokens.js";
import { FakeClaude, say } from "./fake-claude.js";
import { FakeClock } from "./fake-clock.js";
import {
  answered,
  commandsOf,
  initiated,
  postWebhook,
  relayPathOf,
  RelayClient,
  setupFrame,
  startStandIn,
  until,
  type StandIn,
} from "./phone-stand-in.js";

/**
 * The phone server in this process, with a clock the test moves, for what the program test cannot wait for: the
 * 30 seconds of a Relay token and the 10 minutes of a Call. The model is scripted and the Telnyx API is the local
 * stand-in, so nothing reaches the network.
 */

let flow: Flow;
beforeAll(async () => {
  flow = await loadFlow("flows/receptionist.json");
});

let standIn: StandIn;
let server: PhoneServer;
let clock: FakeClock;
let printed: string[];
const relays: RelayClient[] = [];

beforeEach(async () => {
  standIn = await startStandIn();
  // The clock starts at the real time, since the signature on a webhook is made with it.
  clock = new FakeClock(Date.now());
  printed = [];
  const read = readPhoneConfig({
    ANTHROPIC_API_KEY: "test-key",
    TELNYX_API_KEY: "KEY-telnyx-test-secret",
    TELNYX_PUBLIC_KEY: standIn.publicKey,
    PUBLIC_BASE_URL: "https://phone.example.test",
  });
  if ("problems" in read) throw new Error(read.problems.join(" | "));
  const config: PhoneConfig = read.config;
  server = await startPhoneServer(
    {
      config,
      engine: new FlowEngine(flow, { client: new FakeClaude([say("Hello, this is Ava from Acme Co.")]) }),
      client: new TelnyxClient({ apiKey: "KEY-telnyx-test-secret", baseUrl: standIn.url }),
      write: (text) => void printed.push(text),
      now: clock.now,
      rules: { clock: clock.now, after: clock.after },
    },
    0,
  );
});
afterEach(async () => {
  for (const relay of relays.splice(0)) relay.close();
  await server.close();
  await new Promise<void>((done) => standIn.server.close(() => done()));
});

async function answeredCall(): Promise<void> {
  await postWebhook(server.port, standIn, initiated(), { timestamp: Math.floor(clock.now() / 1000) });
  await until("the answer command", () => commandsOf(standIn, "answer").length === 1);
  await postWebhook(server.port, standIn, answered(), { timestamp: Math.floor(clock.now() / 1000) });
  await until("the Relay start command", () => commandsOf(standIn, "conversation_relay_start").length === 1);
}

function relay(): RelayClient {
  const connection = new RelayClient(server.port, relayPathOf(standIn), standIn);
  relays.push(connection);
  return connection;
}

describe("the Relay token's time", () => {
  it("is good for 30 seconds", async () => {
    await answeredCall();
    clock.advance(RELAY_TOKEN_TTL_MS);

    const connection = relay();
    expect(await connection.opened).toBe(true);
    connection.send(setupFrame());

    await until("the greeting", () => connection.frames.length === 1);
  });

  it("is refused after 30 seconds", async () => {
    await answeredCall();
    clock.advance(RELAY_TOKEN_TTL_MS + 1);

    const connection = relay();
    await connection.done();

    expect(connection.refusedWith).toBe(401);
    expect(await connection.opened).toBe(false);
  });
});

describe("a Call's time limit", () => {
  it("ends a Call 10 minutes after it arrived, closing with the time limit line", async () => {
    await answeredCall();
    const connection = relay();
    await connection.opened;
    connection.send(setupFrame());
    await until("the greeting", () => connection.frames.length === 1);

    clock.advance(TIME_LIMIT_MS);

    await until("the closing speech", () => commandsOf(standIn, "speak").length === 1);
    expect(commandsOf(standIn, "speak")[0]!.body.payload).toBe(TIME_LIMIT_LINE);
    expect(standIn.commands()).toContain("conversation_relay_stop");
    expect(standIn.commands()).not.toContain("hangup");
  });
});
