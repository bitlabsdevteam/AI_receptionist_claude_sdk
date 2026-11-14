import { beforeAll, describe, expect, it } from "vitest";
import { FlowEngine } from "../src/engine/engine.js";
import type { ModelClient, ModelResponse } from "../src/engine/model.js";
import { InMemorySessionStore } from "../src/engine/session.js";
import { loadFlow } from "../src/flow/load.js";
import type { Flow } from "../src/flow/schema.js";
import { FakeClaude, reply, say } from "./fake-claude.js";

const GREETING = "Hello, this is Ava from Acme Co. How can I help you today?";
const CALLER = "What time do you open?";
const ANSWER = "I'm sorry, I don't have our opening hours. Is there anything else I can help with?";

let flow: Flow;
beforeAll(async () => {
  flow = await loadFlow("flows/receptionist.json");
});

/** A Call that has been opened and greeted, so the next model reply scripted is the answer to a Turn. */
async function openedCall(...script: ModelResponse[]) {
  const client = new FakeClaude([say(GREETING), ...script]);
  const store = new InMemorySessionStore();
  const engine = new FlowEngine(flow, { client, store });
  await engine.start("call-1", {});
  return { client, store, engine };
}

describe("answering a Turn", () => {
  it("returns the Receptionist's reply from the current Node and stays on it", async () => {
    const { engine } = await openedCall(say(ANSWER));

    const result = await engine.handleUser("call-1", CALLER, "turn-1");

    expect(result).toEqual({ reply: ANSWER, nodeId: "start", ended: false, actions: [] });
  });

  it("appends both sides of the Turn to the Call's transcript", async () => {
    const { engine, store } = await openedCall(say(ANSWER));

    await engine.handleUser("call-1", CALLER, "turn-1");

    const session = await store.get("call-1");
    expect(session?.transcript).toEqual([
      { role: "receptionist", text: GREETING },
      { role: "caller", text: CALLER },
      { role: "receptionist", text: ANSWER },
    ]);
  });

  it("shows the model the Call so far, ending with the Caller's words, under the Node's instructions", async () => {
    const { engine, client } = await openedCall(say(ANSWER));

    await engine.handleUser("call-1", CALLER, "turn-1");

    const req = client.requests[1]!;
    expect(req.system).toContain("You are Ava, the virtual receptionist for Acme Co.");
    expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(req.messages[1]).toEqual({ role: "assistant", content: GREETING });
    expect(req.messages[2]).toEqual({ role: "user", content: CALLER });
  });

  it("builds up the Call across Turns, so the model sees earlier Turns", async () => {
    const { engine, client } = await openedCall(say("First answer."), say("Second answer."));

    await engine.handleUser("call-1", "One?", "turn-1");
    await engine.handleUser("call-1", "Two?", "turn-2");

    expect(client.requests[2]!.messages.map((m) => m.content)).toEqual([
      expect.stringContaining("The Call has just connected"),
      GREETING,
      "One?",
      "First answer.",
      "Two?",
    ]);
  });

  it("leaves the Call untouched when the model call fails, so the same turn id can be retried", async () => {
    const failing: ModelClient = {
      createMessage: async () => {
        throw new Error("provider down");
      },
    };
    const store = new InMemorySessionStore();
    await new FlowEngine(flow, { client: new FakeClaude([say(GREETING)]), store }).start("call-1", {});
    const before = await store.get("call-1");

    await expect(new FlowEngine(flow, { client: failing, store }).handleUser("call-1", CALLER, "turn-1")).rejects.toThrow(
      /provider down/,
    );
    expect(await store.get("call-1")).toEqual(before);

    const retry = new FlowEngine(flow, { client: new FakeClaude([say(ANSWER)]), store });
    expect((await retry.handleUser("call-1", CALLER, "turn-1")).reply).toBe(ANSWER);
  });
});

describe("repeating a Turn", () => {
  it("returns the stored result for a repeated turn id, without calling the model or touching the transcript", async () => {
    const { engine, client, store } = await openedCall(say(ANSWER), say("never used"));
    const first = await engine.handleUser("call-1", CALLER, "turn-1");
    const transcriptAfterFirst = (await store.get("call-1"))?.transcript;

    const replay = await engine.handleUser("call-1", CALLER, "turn-1");

    expect(replay).toEqual(first);
    expect(client.requests).toHaveLength(2);
    expect((await store.get("call-1"))?.transcript).toEqual(transcriptAfterFirst);
  });

  it("replays an earlier Turn even after later Turns, and still answers a new turn id", async () => {
    const { engine, client } = await openedCall(say("First answer."), say("Second answer."));
    const first = await engine.handleUser("call-1", "One?", "turn-1");
    await engine.handleUser("call-1", "Two?", "turn-2");

    expect(await engine.handleUser("call-1", "One?", "turn-1")).toEqual(first);
    expect(client.requests).toHaveLength(3);
  });

  it("replays from the stored Call alone, so it works across engine instances sharing a store", async () => {
    const { engine, store } = await openedCall(say(ANSWER));
    await engine.handleUser("call-1", CALLER, "turn-1");

    const other = new FlowEngine(flow, { client: new FakeClaude([]), store });

    expect((await other.handleUser("call-1", CALLER, "turn-1")).reply).toBe(ANSWER);
  });

  it("treats two overlapping requests with the same turn id as one Turn", async () => {
    const { engine, client, store } = await openedCall(say(ANSWER), say("never used"));

    const [a, b] = await Promise.all([
      engine.handleUser("call-1", CALLER, "turn-1"),
      engine.handleUser("call-1", CALLER, "turn-1"),
    ]);

    expect(a).toEqual(b);
    expect(client.requests).toHaveLength(2);
    expect((await store.get("call-1"))?.transcript).toHaveLength(3);
  });
});

describe("a reply the Receptionist cannot speak", () => {
  const SAFE_REPEAT = "Sorry, could you say that again?";

  it("replaces an empty model reply with a safe spoken line, and records it as what the Receptionist said", async () => {
    const { engine, store } = await openedCall(say(""));

    const result = await engine.handleUser("call-1", CALLER, "turn-1");

    expect(result.reply).toBe(SAFE_REPEAT);
    expect((await store.get("call-1"))?.transcript.at(-1)).toEqual({ role: "receptionist", text: SAFE_REPEAT });
  });

  it("treats a reply of only whitespace, or with no text blocks, as empty", async () => {
    const { engine } = await openedCall(say("  \n "), reply([]));

    expect((await engine.handleUser("call-1", CALLER, "turn-1")).reply).toBe(SAFE_REPEAT);
    expect((await engine.handleUser("call-1", CALLER, "turn-2")).reply).toBe(SAFE_REPEAT);
  });

  it("answers a model refusal with a safe spoken line, whatever text came with it, and stays on the current Node", async () => {
    const { engine, store } = await openedCall(reply([{ type: "text", text: "partial unsafe text" }], "refusal"));

    const result = await engine.handleUser("call-1", CALLER, "turn-1");

    expect(result.reply).not.toBe("");
    expect(result.reply).not.toContain("partial unsafe text");
    expect(result).toMatchObject({ nodeId: "start", ended: false, actions: [] });
    const session = await store.get("call-1");
    expect(session?.currentNodeId).toBe("start");
    expect(session?.transcript.slice(-2)).toEqual([
      { role: "caller", text: CALLER },
      { role: "receptionist", text: result.reply },
    ]);
  });

  it("keeps working after a refusal: the next Turn is answered normally", async () => {
    const { engine } = await openedCall(reply([], "refusal"), say(ANSWER));

    await engine.handleUser("call-1", "Something refused", "turn-1");

    expect((await engine.handleUser("call-1", CALLER, "turn-2")).reply).toBe(ANSWER);
  });

  it("stores the safe line for a refused Turn, so a replay does not ask the model again", async () => {
    const { engine, client } = await openedCall(reply([], "refusal"), say("never used"));
    const first = await engine.handleUser("call-1", CALLER, "turn-1");

    expect(await engine.handleUser("call-1", CALLER, "turn-1")).toEqual(first);
    expect(client.requests).toHaveLength(2);
  });
});

describe("what the Receptionist may promise", () => {
  // The honesty about unsupported requests lives in the start Node's instructions (flow data), not engine code.
  // These tests pin that the Flow's instructions are what the model is given, and that they say it.
  it("gives the model the start Node's instructions, with Flow variables filled in, on every Turn", async () => {
    const { engine, client } = await openedCall(say("Sorry, I cannot do that yet."));

    await engine.handleUser("call-1", "Can you check my balance?", "turn-1");

    const startNode = flow.nodes.find((n) => n.id === flow.start_node)!;
    const system = client.requests[1]!.system;
    expect(system).toContain(
      startNode.instructions.replaceAll("{{assistant_name}}", "Ava").replaceAll("{{company_name}}", "Acme Co."),
    );
    expect(system).not.toContain("{{");
  });

  it("tells the model to admit it cannot yet do things like a balance check, and to answer only from what it was given", () => {
    const instructions = flow.nodes.find((n) => n.id === flow.start_node)!.instructions;

    expect(instructions).toMatch(/balance/i);
    expect(instructions).toMatch(/cannot|can't/i);
    expect(instructions).toMatch(/do not offer|never offer|don't offer/i);
    expect(instructions).toMatch(/only (from|using) /i);
  });
});

describe("a Turn on a Call that cannot take one", () => {
  it("names the Call id when it does not exist, without calling the model", async () => {
    const client = new FakeClaude([say("never used")]);
    const engine = new FlowEngine(flow, { client });

    await expect(engine.handleUser("nope", CALLER, "turn-1")).rejects.toThrow(/Call "nope" does not exist/);
    expect(client.requests).toHaveLength(0);
  });

  it("says so when the Call has ended, without calling the model or changing the Call", async () => {
    const { engine, client, store } = await openedCall(say("never used"));
    const session = (await store.get("call-1"))!;
    await store.put({ ...session, endState: "goodbye" });

    await expect(engine.handleUser("call-1", CALLER, "turn-1")).rejects.toThrow(/Call "call-1" has ended/);
    expect(client.requests).toHaveLength(1);
    expect((await store.get("call-1"))?.transcript).toEqual(session.transcript);
  });
});
