import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLOSING_STALL_MS, TIME_LIMIT_LINE, TIME_LIMIT_MS, TROUBLE_LINE } from "../src/adapters/phone.js";
import { RELAY_SETUP_TIMEOUT_MS, startPhoneServer, type PhoneServer } from "../src/adapters/phone-server.js";
import { FlowEngine } from "../src/engine/engine.js";
import { loadFlow } from "../src/flow/load.js";
import type { Flow } from "../src/flow/schema.js";
import { readPhoneConfig, type PhoneConfig } from "../src/phone-config.js";
import { TelnyxClient } from "../src/telnyx/client.js";
import { RELAY_TOKEN_TTL_MS } from "../src/telnyx/relay-tokens.js";
import { FakeClaude, say } from "./fake-claude.js";
import type { ModelResponse } from "../src/engine/model.js";
import { FakeClock } from "./fake-clock.js";
import {
  answered,
  commandsOf,
  hangup,
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

interface Boot {
  /** What the model says, in order. Defaults to the greeting alone. */
  script?: ModelResponse[];
  /** Wraps what the server prints, which a test may make throw. */
  write?: (text: string, print: (text: string) => void) => void;
}

async function boot({ script = [say("Hello, this is Ava from Acme Co.")], write }: Boot = {}): Promise<void> {
  const read = readPhoneConfig({
    ANTHROPIC_API_KEY: "test-key",
    TELNYX_API_KEY: "KEY-telnyx-test-secret",
    TELNYX_PUBLIC_KEY: standIn.publicKey,
    PUBLIC_BASE_URL: "https://phone.example.test",
  });
  if ("problems" in read) throw new Error(read.problems.join(" | "));
  const config: PhoneConfig = read.config;
  const print = (text: string): void => void printed.push(text);
  server = await startPhoneServer(
    {
      config,
      engine: new FlowEngine(flow, { client: new FakeClaude(script) }),
      client: new TelnyxClient({ apiKey: "KEY-telnyx-test-secret", baseUrl: standIn.url }),
      write: write ? (text) => write(text, print) : print,
      now: clock.now,
      rules: { clock: clock.now, after: clock.after },
    },
    0,
  );
}

/** Stops the server the test started with and starts another one, as `options` say. */
async function reboot(options: Boot): Promise<void> {
  await server.close();
  await boot(options);
}

beforeEach(async () => {
  standIn = await startStandIn();
  // The clock starts at the real time, since the signature on a webhook is made with it.
  clock = new FakeClock(Date.now());
  printed = [];
  await boot();
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

describe("a Call that was closed before it was answered", () => {
  it("is hung up, not spoken to, and a late answered event starts no Relay", async () => {
    // The greeting cannot be made, so the Call is closed at once: the Caller has not even been answered yet.
    await reboot({ script: [] });
    await postWebhook(server.port, standIn, initiated(), { timestamp: Math.floor(clock.now() / 1000) });
    await until("the hang-up command", () => commandsOf(standIn, "hangup").length === 1);

    await postWebhook(server.port, standIn, answered(), { timestamp: Math.floor(clock.now() / 1000) });
    await until("the late event to be noticed", () => printed.join("").includes("is being closed"));

    expect(standIn.commands()).not.toContain("conversation_relay_start");
    expect(standIn.commands()).not.toContain("conversation_relay_stop");
    expect(standIn.commands()).not.toContain("speak");
  });

  it("is still closed with its words when it was answered, whatever the order of the commands", async () => {
    await answeredCall();
    const connection = relay();
    await connection.opened;
    connection.send(setupFrame());
    await until("the greeting", () => connection.frames.length === 1);

    clock.advance(TIME_LIMIT_MS);

    await until("the closing speech", () => commandsOf(standIn, "speak").length === 1);
    expect(commandsOf(standIn, "hangup")).toHaveLength(0);
  });
});

describe("a Relay connection that does not send its setup", () => {
  it("is closed after 10 seconds, and the Call is closed with the trouble line", async () => {
    await answeredCall();
    const connection = relay();
    await connection.opened;

    clock.advance(RELAY_SETUP_TIMEOUT_MS - 1);
    expect(connection.closed).toBeUndefined();
    clock.advance(1);

    await connection.done();
    await until("the closing speech", () => commandsOf(standIn, "speak").length === 1);
    expect(commandsOf(standIn, "speak")[0]!.body.payload).toBe(TROUBLE_LINE);
  });

  it("is left alone once its setup has come", async () => {
    await answeredCall();
    const connection = relay();
    await connection.opened;
    connection.send(setupFrame());
    await until("the greeting", () => connection.frames.length === 1);

    clock.advance(RELAY_SETUP_TIMEOUT_MS);

    expect(connection.closed).toBeUndefined();
    expect(standIn.commands()).not.toContain("speak");
  });
});

describe("an event's id", () => {
  it("is not spent by a delivery whose handling failed, so the retry is handled", async () => {
    let failed = false;
    await reboot({
      write: (text, print) => {
        if (!failed && text.startsWith("The Caller hung up.")) {
          failed = true;
          throw new Error("the terminal went away");
        }
        print(text);
      },
    });
    await postWebhook(server.port, standIn, initiated(), { timestamp: Math.floor(clock.now() / 1000) });
    await until("the answer command", () => commandsOf(standIn, "answer").length === 1);
    const goodbye = hangup("event-hangup");

    await postWebhook(server.port, standIn, goodbye);
    await until("the failure", () => printed.join("").includes("Could not handle a webhook: the terminal went away"));
    await postWebhook(server.port, standIn, goodbye);
    await until("the retry to be handled", () => printed.some((text) => text.startsWith("The Caller hung up.")));

    expect(printed.join("")).not.toContain("repeated event");
  });

  it("is ignored when it is delivered again while the first delivery is still being handled", async () => {
    const release = standIn.hold();
    const arrival = initiated(undefined, "event-arrival");
    await postWebhook(server.port, standIn, arrival, { timestamp: Math.floor(clock.now() / 1000) });
    await until("the answer command", () => commandsOf(standIn, "answer").length === 1);

    await postWebhook(server.port, standIn, arrival, { timestamp: Math.floor(clock.now() / 1000) });
    await until("the repeat to be noticed", () => printed.join("").includes("repeated event"));
    release();

    await until("the first delivery to finish", () => printed.join("").includes("Call arrived"));
    expect(commandsOf(standIn, "answer")).toHaveLength(1);
  });
});

describe("a closing that stalls", () => {
  it("lets go of the Call when it hangs up, though Telnyx never reports the hang-up", async () => {
    await answeredCall();
    const connection = relay();
    await connection.opened;
    connection.send(setupFrame());
    await until("the greeting", () => connection.frames.length === 1);
    clock.advance(TIME_LIMIT_MS);
    await until("the closing speech", () => commandsOf(standIn, "speak").length === 1);
    expect(connection.closed).toBeUndefined();

    clock.advance(CLOSING_STALL_MS);

    await until("the hang-up command", () => commandsOf(standIn, "hangup").length === 1);
    // The Relay connection is dropped and what arrives for the Call after that is ignored.
    await connection.done();
    await postWebhook(server.port, standIn, hangup(), { timestamp: Math.floor(clock.now() / 1000) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(printed.join("")).not.toContain("Ignored a hang-up for an unknown Call");
    expect((await server.hangUpAll())).toBe(0);
  });
});
