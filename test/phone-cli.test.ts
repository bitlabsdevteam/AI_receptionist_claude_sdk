import { generateKeyPairSync } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answered,
  CALL_CONTROL_ID,
  CALLER,
  commandsOf,
  GOODBYE_MESSAGE,
  get,
  GREETING,
  hangup,
  HELP_REPLY,
  initiated,
  postWebhook,
  promptFrame,
  relayPathOf,
  RelayClient,
  setupFrame,
  speakEnded,
  startStandIn,
  until,
  webhookBody,
  type StandIn,
} from "./phone-stand-in.js";

/**
 * Runs the real program, as `npm run phone` does, with nothing real behind it: one throwaway HTTP server stands in for
 * Anthropic and the Telnyx API (`ANTHROPIC_BASE_URL`, `TELNYX_BASE_URL`), and this test plays Telnyx's other sides: it
 * signs its own webhooks with a key pair made for the run and opens the Relay connection itself. It reaches no
 * network, starts no ngrok and places no call. It proves the wiring and nothing about Telnyx itself.
 */

const PUBLIC_BASE_URL = "https://phone.example.test";

let standIn: StandIn | undefined;
let child: ChildProcess | undefined;
let dir: string;
const relays: RelayClient[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "receptionist-phone-"));
});
afterEach(async () => {
  for (const relay of relays.splice(0)) relay.close();
  child?.kill("SIGKILL");
  child = undefined;
  await new Promise<void>((done) => (standIn ? standIn.server.close(() => done()) : done()));
  standIn = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ready) => probe.listen(0, "127.0.0.1", ready));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

interface Running {
  port: number;
  /** Everything the program has printed to stdout so far. */
  stdout: () => string;
  stderr: () => string;
  exit: Promise<number | null>;
}

function envFor(stand: StandIn, port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: "test-key",
    ANTHROPIC_BASE_URL: stand.url,
    TELNYX_API_KEY: "KEY-telnyx-test-secret",
    TELNYX_PUBLIC_KEY: stand.publicKey,
    TELNYX_BASE_URL: stand.url,
    PUBLIC_BASE_URL,
    PORT: String(port),
    ...extra,
  };
}

/** Starts the program in an empty directory (so no `.env` is read) and, with `ready`, waits until it is listening. */
async function runPhone(env: Record<string, string>, ready = true): Promise<Running> {
  const cwd = join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  // Nothing is on the PATH, so ngrok could not be started even if something tried.
  const proc = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("src/adapters/phone-cli.ts")], {
    cwd,
    env: { PATH: "", ...env },
    timeout: 30_000,
  });
  child = proc;
  let stdout = "";
  let stderr = "";
  proc.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
  proc.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  const exit = new Promise<number | null>((done) => proc.on("close", (code) => done(code)));
  const running: Running = { port: Number(env.PORT), stdout: () => stdout, stderr: () => stderr, exit };
  if (ready) await until("the program to listen", () => stdout.includes("Listening on port"));
  return running;
}

async function start(extra: Record<string, string> = {}): Promise<{ stand: StandIn; phone: Running }> {
  standIn = await startStandIn();
  const phone = await runPhone(envFor(standIn, await freePort(), extra));
  return { stand: standIn, phone };
}

/** A Call that has arrived, been answered and been told to start the Relay, up to the point Telnyx connects. */
async function answeredCall(stand: StandIn, phone: Running): Promise<void> {
  expect(await postWebhook(phone.port, stand, initiated())).toBe(200);
  await until("the answer command", () => commandsOf(stand, "answer").length === 1);
  expect(await postWebhook(phone.port, stand, answered())).toBe(200);
  await until("the Relay start command", () => commandsOf(stand, "conversation_relay_start").length === 1);
}

async function connectedCall(stand: StandIn, phone: Running): Promise<RelayClient> {
  await answeredCall(stand, phone);
  const relay = new RelayClient(phone.port, relayPathOf(stand), stand);
  relays.push(relay);
  expect(await relay.opened).toBe(true);
  relay.send(setupFrame());
  return relay;
}

describe("the phone program at startup", () => {
  it("names every missing variable, one line each, and exits 1 without listening", async () => {
    const phone = await runPhone({ PORT: String(await freePort()) }, false);

    expect(await phone.exit).toBe(1);
    expect(phone.stderr().trimEnd().split("\n").map((line) => line.split(" ")[0])).toEqual([
      "ANTHROPIC_API_KEY",
      "TELNYX_API_KEY",
      "TELNYX_PUBLIC_KEY",
      "PUBLIC_BASE_URL",
    ]);
    for (const line of phone.stderr().trimEnd().split("\n")) expect(line).toContain("is not set");
    expect(phone.stdout()).toBe("");
    // It never listened: nothing answers on its port.
    await expect(get(phone.port, "/telnyx/webhooks", "POST")).rejects.toThrow();
  });

  it("names the one variable that is missing", async () => {
    standIn = await startStandIn();
    const { TELNYX_PUBLIC_KEY: _missing, ...env } = envFor(standIn, await freePort());

    const phone = await runPhone(env, false);

    expect(await phone.exit).toBe(1);
    expect(phone.stderr()).toBe(
      "TELNYX_PUBLIC_KEY is not set. Put your Telnyx account's public key from the portal in .env, or export TELNYX_PUBLIC_KEY in your shell.\n",
    );
  });

  it("prints the webhook address to paste into the portal, and never a key", async () => {
    const { stand, phone } = await start();

    expect(phone.stdout()).toContain(`Webhook address: ${PUBLIC_BASE_URL}/telnyx/webhooks\n`);
    expect(phone.stdout()).toContain(`Listening on port ${phone.port}.`);
    expect(phone.stdout() + phone.stderr()).not.toContain("KEY-telnyx-test-secret");
    expect(phone.stdout() + phone.stderr()).not.toContain(stand.publicKey);
  });
});

describe("a whole Call on the phone program", () => {
  it("runs from a signed arrival to the hang-up, in order, and says the closing message once", async () => {
    const { stand, phone } = await start({ PHONE_ALLOWED_CALLERS: `+14155550100,${CALLER}` });

    const relay = await connectedCall(stand, phone);
    await until("the greeting", () => relay.frames.length === 1);

    relay.send(promptFrame("What do you do?"));
    await until("the reply", () => relay.frames.length === 2);

    relay.send(promptFrame("Ok, bye for now."));
    await until("the closing speech", () => commandsOf(stand, "speak").length === 1);
    expect(await postWebhook(phone.port, stand, speakEnded())).toBe(200);
    await until("the hang-up", () => commandsOf(stand, "hangup").length === 1);
    await until("the Call to end", () => phone.stdout().includes("The Call ended."));

    // The commands and frames, in the order the program sent them.
    expect(stand.seen.map((s) => (s.kind === "frame" ? `frame:${String(s.frame.type)}` : s.command))).toEqual([
      "answer",
      "conversation_relay_start",
      "frame:text",
      "frame:text",
      "conversation_relay_stop",
      "speak",
      "hangup",
    ]);
    expect(relay.frames).toEqual([
      { type: "text", token: GREETING, last: true },
      { type: "text", token: HELP_REPLY, last: true },
    ]);

    const commands = stand.seen.filter((s) => s.kind === "command");
    for (const command of commands) {
      expect(command.callControlId).toBe(CALL_CONTROL_ID);
      expect(command.authorization).toBe("Bearer KEY-telnyx-test-secret");
    }
    const relayStart = commandsOf(stand, "conversation_relay_start")[0]!;
    expect(String(relayStart.body.url)).toMatch(/^wss:\/\/phone\.example\.test\/telnyx\/relay\/[A-Za-z0-9_-]{43}$/);
    expect(relayStart.body).toMatchObject({
      voice: "Telnyx.Ultra.Callie",
      transcription_engine: "Deepgram",
      transcription_engine_config: { transcription_model: "deepgram/nova-3" },
      language: "en",
      interruptible: "speech",
    });
    expect(commandsOf(stand, "speak")[0]!.body).toMatchObject({ payload: GOODBYE_MESSAGE, voice: "Telnyx.Ultra.Callie" });

    // The Call's id is the call session id, and the Turns were numbered from it.
    expect(JSON.stringify(stand.model[1]!.messages)).toContain("What do you do?");
    const printed = phone.stdout();
    expect(printed).toContain("Call arrived from a number ending 0133.\n");
    expect(printed).toContain(`Receptionist: ${GREETING}\nCaller: What do you do?\nReceptionist: ${HELP_REPLY}\n`);
    expect(printed).toContain(`Receptionist: ${GOODBYE_MESSAGE}\n`);
    expect(printed.split(GOODBYE_MESSAGE)).toHaveLength(2);
    expect(printed).not.toContain(CALLER);
    expect(phone.stdout() + phone.stderr()).not.toContain("KEY-telnyx-test-secret");

    // The hang-up that follows is Telnyx's report of the Call being over, and changes nothing.
    expect(await postWebhook(phone.port, stand, hangup())).toBe(200);
  });

  it("tells the rules the Caller hung up, and says nothing more to them", async () => {
    const { stand, phone } = await start();
    const relay = await connectedCall(stand, phone);
    await until("the greeting", () => relay.frames.length === 1);

    expect(await postWebhook(phone.port, stand, hangup())).toBe(200);
    await until("the hang-up", () => phone.stdout().includes("The Caller hung up."));
    await relay.done();

    expect(stand.commands()).toEqual(["answer", "conversation_relay_start"]);
  });

  it("closes with the trouble line when the Relay connection drops", async () => {
    const { stand, phone } = await start();
    const relay = await connectedCall(stand, phone);
    await until("the greeting", () => relay.frames.length === 1);

    relay.close();

    await until("the closing speech", () => commandsOf(stand, "speak").length === 1);
    expect(commandsOf(stand, "speak")[0]!.body.payload).toBe("Sorry, we're having technical trouble. Please call back later.");
    expect(stand.commands()).toContain("conversation_relay_stop");
  });

  it("acknowledges a webhook at once and acts after, so a slow command holds up nothing", async () => {
    const { stand, phone } = await start();
    const release = stand.hold();

    // The answer command is held by the stand-in, yet the webhook that caused it is already acknowledged.
    expect(await postWebhook(phone.port, stand, initiated())).toBe(200);
    await until("the answer command", () => commandsOf(stand, "answer").length === 1);
    release();
  });

  it("hangs up the Calls in progress and exits 0 on Ctrl-C", async () => {
    const { stand, phone } = await start();
    const relay = await connectedCall(stand, phone);
    await until("the greeting", () => relay.frames.length === 1);

    child!.kill("SIGINT");

    expect(await phone.exit).toBe(0);
    expect(commandsOf(stand, "hangup")).toHaveLength(1);
    expect(commandsOf(stand, "hangup")[0]!.callControlId).toBe(CALL_CONTROL_ID);
    expect(phone.stderr()).toBe("");
  });

  it("exits 0 on Ctrl-C with no Call in progress, sending nothing", async () => {
    const { stand, phone } = await start();

    child!.kill("SIGINT");

    expect(await phone.exit).toBe(0);
    expect(stand.commands()).toEqual([]);
  });
});

describe("who may reach the phone program", () => {
  it("answers 401 to an unsigned webhook and acts on nothing", async () => {
    const { stand, phone } = await start();

    expect(await postWebhook(phone.port, stand, initiated(), { unsigned: true })).toBe(401);
    await until("the refusal to be printed", () => phone.stdout().includes("Refused a webhook"));

    expect(stand.commands()).toEqual([]);
    expect(phone.stdout()).not.toContain("Call arrived");
  });

  it("answers 401 to a webhook signed with another key", async () => {
    const { stand, phone } = await start();

    expect(await postWebhook(phone.port, stand, initiated(), { signWith: generateKeyPairSync("ed25519").privateKey })).toBe(401);

    expect(stand.commands()).toEqual([]);
  });

  it("answers 401 to a webhook signed correctly but more than 5 minutes old", async () => {
    const { stand, phone } = await start();

    expect(await postWebhook(phone.port, stand, initiated(), { timestamp: Math.floor(Date.now() / 1000) - 301 })).toBe(401);

    expect(stand.commands()).toEqual([]);
  });

  it("serves only POST /telnyx/webhooks", async () => {
    const { phone } = await start();

    expect(await get(phone.port, "/")).toBe(404);
    expect(await get(phone.port, "/telnyx/webhooks")).toBe(405);
  });

  it("ignores an event it has already seen, by its id", async () => {
    const { stand, phone } = await start();
    const arrival = initiated(CALLER, "event-arrival");

    expect(await postWebhook(phone.port, stand, arrival)).toBe(200);
    await until("the answer command", () => commandsOf(stand, "answer").length === 1);
    expect(await postWebhook(phone.port, stand, arrival)).toBe(200);
    await until("the repeat to be noticed", () => phone.stdout().includes("repeated event"));

    expect(commandsOf(stand, "answer")).toHaveLength(1);
    expect(phone.stdout().match(/Call arrived/g)).toHaveLength(1);
  });

  it("rejects, unanswered, a Caller who is not on the list", async () => {
    const { stand, phone } = await start({ PHONE_ALLOWED_CALLERS: "+14155550100" });

    expect(await postWebhook(phone.port, stand, initiated())).toBe(200);
    await until("the reject command", () => commandsOf(stand, "reject").length === 1);

    expect(stand.commands()).toEqual(["reject"]);
    expect(commandsOf(stand, "reject")[0]!.body).toMatchObject({ cause: "CALL_REJECTED" });
    expect(phone.stdout()).toContain("Rejected a call from a number ending 0133");
    expect(phone.stdout()).not.toContain(CALLER);
    // The Call never began: no greeting was made.
    expect(stand.model).toHaveLength(0);
  });

  it("rejects a withheld number when there is a list", async () => {
    const { stand, phone } = await start({ PHONE_ALLOWED_CALLERS: "+14155550100" });

    await postWebhook(phone.port, stand, webhookBody("call.initiated", { to: "+12025550131", direction: "incoming" }));
    await until("the reject command", () => commandsOf(stand, "reject").length === 1);

    expect(stand.commands()).toEqual(["reject"]);
  });

  it("answers any Caller when there is no list", async () => {
    const { stand, phone } = await start();

    await postWebhook(phone.port, stand, initiated("+12025550199"));
    await until("the answer command", () => commandsOf(stand, "answer").length === 1);

    expect(stand.commands()).toEqual(["answer"]);
  });

  it("does not answer a call that is not marked inbound", async () => {
    const { stand, phone } = await start();

    await postWebhook(phone.port, stand, webhookBody("call.initiated", { from: CALLER, direction: "outgoing" }));
    await postWebhook(phone.port, stand, webhookBody("call.initiated", { from: CALLER }));
    await until("both to be noticed", () => (phone.stdout().match(/not an inbound call/g) ?? []).length === 2);

    expect(stand.commands()).toEqual([]);
  });

  it("refuses a Relay connection with a token it never issued", async () => {
    const { stand, phone } = await start();
    await answeredCall(stand, phone);

    const relay = new RelayClient(phone.port, "/telnyx/relay/not-a-token", stand);
    relays.push(relay);
    await relay.done();

    expect(relay.refusedWith).toBe(401);
    expect(await relay.opened).toBe(false);
  });

  it("refuses a Relay connection that is not at the Relay's path", async () => {
    const { stand, phone } = await start();

    const relay = new RelayClient(phone.port, "/somewhere/else", stand);
    relays.push(relay);
    await relay.done();

    expect(relay.refusedWith).toBe(404);
  });

  it("refuses a token that was used already, and the Call goes on over the first connection", async () => {
    const { stand, phone } = await start();
    const first = await connectedCall(stand, phone);
    await until("the greeting", () => first.frames.length === 1);

    const second = new RelayClient(phone.port, relayPathOf(stand), stand);
    relays.push(second);
    await second.done();

    expect(second.refusedWith).toBe(401);
    first.send(promptFrame("What do you do?"));
    await until("the reply", () => first.frames.length === 2);
    expect(first.frames[1]).toEqual({ type: "text", token: HELP_REPLY, last: true });
  });

  it("refuses a connection whose setup names a different Call, and says nothing to it", async () => {
    const { stand, phone } = await start();
    await answeredCall(stand, phone);

    const relay = new RelayClient(phone.port, relayPathOf(stand), stand);
    relays.push(relay);
    expect(await relay.opened).toBe(true);
    relay.send(setupFrame("some-other-call-session"));
    await relay.done();

    expect(relay.closed?.code).toBe(1008);
    expect(relay.frames).toEqual([]);
    // The connection that carried the token never joined the Call, which is closed with the trouble line.
    await until("the closing speech", () => commandsOf(stand, "speak").length === 1);
    expect(commandsOf(stand, "speak")[0]!.body.payload).toBe("Sorry, we're having technical trouble. Please call back later.");
  });

  it("refuses a connection whose first frame is not a setup", async () => {
    const { stand, phone } = await start();
    await answeredCall(stand, phone);

    const relay = new RelayClient(phone.port, relayPathOf(stand), stand);
    relays.push(relay);
    expect(await relay.opened).toBe(true);
    relay.send(promptFrame("hello"));
    await relay.done();

    expect(relay.closed?.code).toBe(1008);
    expect(relay.frames).toEqual([]);
  });
});

describe("events that arrive out of order", () => {
  it("ignores an answered event for a Call it never saw arrive", async () => {
    const { stand, phone } = await start();

    expect(await postWebhook(phone.port, stand, answered())).toBe(200);
    await until("the event to be noticed", () => phone.stdout().includes("unknown Call"));

    expect(stand.commands()).toEqual([]);
  });

  it("starts no Relay for a Call whose hang-up arrived before its answered event", async () => {
    const { stand, phone } = await start();
    await postWebhook(phone.port, stand, initiated());
    await until("the answer command", () => commandsOf(stand, "answer").length === 1);

    await postWebhook(phone.port, stand, hangup());
    await until("the hang-up", () => phone.stdout().includes("The Caller hung up."));
    await postWebhook(phone.port, stand, answered());
    await until("the late event to be noticed", () => phone.stdout().includes("unknown Call"));

    expect(stand.commands()).toEqual(["answer"]);
  });

  it("does not take a late arrival for a Call that is over as a new Call", async () => {
    const { stand, phone } = await start();
    await postWebhook(phone.port, stand, hangup());
    await until("the hang-up to be noticed", () => phone.stdout().includes("unknown Call"));

    await postWebhook(phone.port, stand, initiated());
    await until("the late arrival to be noticed", () => phone.stdout().includes("already over"));

    expect(stand.commands()).toEqual([]);
  });

  it("starts the Relay once for an answered event delivered twice under different ids", async () => {
    const { stand, phone } = await start();
    await answeredCall(stand, phone);

    await postWebhook(phone.port, stand, answered());
    await until("the repeat to be noticed", () => phone.stdout().includes("already has a Relay"));

    expect(commandsOf(stand, "conversation_relay_start")).toHaveLength(1);
  });

  it("closes with the speech ended event delivered before the closing began, ignoring it", async () => {
    const { stand, phone } = await start();
    const relay = await connectedCall(stand, phone);
    await until("the greeting", () => relay.frames.length === 1);

    expect(await postWebhook(phone.port, stand, speakEnded())).toBe(200);
    await until("the event to be noticed", () => phone.stdout().includes("not being closed"));

    expect(stand.commands()).toEqual(["answer", "conversation_relay_start"]);
  });
});
