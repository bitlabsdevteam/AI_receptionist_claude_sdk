import { beforeAll, describe, expect, it } from "vitest";
import { FlowEngine } from "../src/engine/engine.js";
import { InMemorySessionStore } from "../src/engine/session.js";
import { loadFlow } from "../src/flow/load.js";
import type { Flow } from "../src/flow/schema.js";
import { FakeClaude, GREETING, reply, say } from "./fake-claude.js";

let flow: Flow;
beforeAll(async () => {
  flow = await loadFlow("flows/receptionist.json");
});

function openCall(script = [say(GREETING)]) {
  const client = new FakeClaude(script);
  const store = new InMemorySessionStore();
  const engine = new FlowEngine(flow, { client, store });
  return { client, store, engine };
}

describe("opening a Call", () => {
  it("returns the Receptionist's greeting from the start Node, with no Caller input", async () => {
    const { engine } = openCall();

    const result = await engine.start("call-1", {});

    expect(result.reply).toBe(GREETING);
    expect(result.reply).toMatch(/Ava/);
    expect(result.reply).toMatch(/Acme Co\./);
    expect(result.nodeId).toBe("start");
    expect(result.ended).toBe(false);
    expect(result.actions).toEqual([]);
  });

  it("asks the start Node's model for the greeting, with rendered instructions in the system prompt", async () => {
    const { engine, client } = openCall();

    await engine.start("call-1", {});

    expect(client.requests).toHaveLength(1);
    const req = client.requests[0]!;
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.provider).toBe("anthropic");
    expect(req.system).toContain("Greet the caller warmly, say your name and company, and ask how you can help.");
    expect(req.system).toContain("You are Ava, the virtual receptionist for Acme Co.");
    expect(req.system).not.toContain("{{");
    expect(req.effort).toBe("low");
    // Adaptive thinking counts toward max_tokens, so the limit is far above a 1 to 3 sentence reply.
    expect(req.maxTokens).toBe(1024);
    // The Messages API needs a user message first, even though the Caller has not spoken.
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]?.role).toBe("user");
  });

  it("tells the start Node to end the Call without a farewell of its own, because the End state speaks one", () => {
    const start = flow.nodes.find((n) => n.id === flow.start_node)!;

    expect(start.instructions).toMatch(/without (saying|giving|adding) (a|any) (farewell|goodbye)/i);
    expect(start.instructions).toMatch(/closing message/i);
  });

  it("sends none of the sampling parameters Sonnet 5.5 rejects", async () => {
    const { engine, client } = openCall();

    await engine.start("call-1", {});

    expect(client.requests[0]).not.toHaveProperty("temperature");
    expect(client.requests[0]).not.toHaveProperty("top_p");
    expect(client.requests[0]).not.toHaveProperty("top_k");
  });

  it("uses the Node's own model when it overrides the Flow default", async () => {
    const overridden = structuredClone(flow);
    overridden.nodes[0]!.model = "openrouter/acme/voice-1";
    const client = new FakeClaude([say(GREETING)]);

    await new FlowEngine(overridden, { client }).start("call-1", {});

    expect(client.requests[0]).toMatchObject({ provider: "openrouter", model: "acme/voice-1" });
  });

  it("records the greeting in the Call's transcript, without the stand-in user message", async () => {
    const { engine, store } = openCall();

    await engine.start("call-1", {});

    const session = await store.get("call-1");
    expect(session?.currentNodeId).toBe("start");
    expect(session?.transcript).toEqual([{ role: "receptionist", text: GREETING }]);
  });

  it("keeps the Flow variables and the caller's number on the Call for later templating", async () => {
    const { engine, store } = openCall();

    await engine.start("call-1", { callerNumber: "+15551230000" });

    const session = await store.get("call-1");
    expect(session?.variables).toEqual({
      receptionist_name: "Ava",
      company_name: "Acme Co.",
      caller_number: "+15551230000",
    });
  });

  it("refuses to open a Call id that is already open, without calling the model", async () => {
    const { engine, client } = openCall([say(GREETING), say("never used")]);
    await engine.start("call-1", {});

    await expect(engine.start("call-1", {})).rejects.toThrow(/call-1.*already/);
    expect(client.requests).toHaveLength(1);
  });

  it("fails loudly, and leaves no Call behind, when instructions use an unknown variable", async () => {
    const broken = structuredClone(flow);
    broken.nodes[0]!.instructions = "Say hello to {{caller_name}}.";
    const client = new FakeClaude([say(GREETING)]);
    const store = new InMemorySessionStore();

    await expect(new FlowEngine(broken, { client, store }).start("call-1", {})).rejects.toThrow(/caller_name/);
    expect(client.requests).toHaveLength(0);
    expect(await store.get("call-1")).toBeUndefined();
  });
});

describe("a greeting the Receptionist cannot speak", () => {
  /** The same Flow with different names, so a safe greeting is seen to come from the Flow's variables. */
  const renamed = () => {
    const copy = structuredClone(flow);
    copy.variables = { ...copy.variables, receptionist_name: "Bea", company_name: "Bolt Ltd." };
    return copy;
  };
  const SAFE_GREETING = "Hello, this is Bea from Bolt Ltd. How can I help you today?";

  it("greets with a safe line built from the Flow's variables when the model refused, whatever text came with it", async () => {
    const client = new FakeClaude([reply([{ type: "text", text: "Sure, here is how to hurt someone" }], "refusal")]);
    const store = new InMemorySessionStore();

    const result = await new FlowEngine(renamed(), { client, store }).start("call-1", {});

    expect(result).toEqual({ reply: SAFE_GREETING, nodeId: "start", ended: false, actions: [] });
    expect((await store.get("call-1"))?.transcript).toEqual([{ role: "receptionist", text: SAFE_GREETING }]);
  });

  it("greets with the safe line when the model said nothing at all", async () => {
    for (const empty of [say(""), say("  \n "), reply([]), reply([], "refusal")]) {
      const store = new InMemorySessionStore();

      const result = await new FlowEngine(renamed(), { client: new FakeClaude([empty]), store }).start("call-1", {});

      expect(result.reply).toBe(SAFE_GREETING);
      expect((await store.get("call-1"))?.transcript).toEqual([{ role: "receptionist", text: SAFE_GREETING }]);
    }
  });

  it("falls back to a plain greeting when the Flow has no name variables", async () => {
    const plain = structuredClone(flow);
    plain.variables = {};
    plain.base_instructions = "You are a receptionist.";
    plain.nodes[0]!.instructions = "Greet the caller.";

    const result = await new FlowEngine(plain, { client: new FakeClaude([say("")]) }).start("call-1", {});

    expect(result.reply).toBe("Hello, thank you for calling. How can I help you today?");
  });

  it("never replays the refused text to the model, and the next Turn is answered normally", async () => {
    const client = new FakeClaude([reply([{ type: "text", text: "partial unsafe text" }], "refusal"), say("We are Bolt.")]);
    const engine = new FlowEngine(renamed(), { client });
    await engine.start("call-1", {});

    const result = await engine.handleUser("call-1", "Who are you?", "turn-1");

    expect(result.reply).toBe("We are Bolt.");
    expect(client.requests[1]!.messages).toEqual([
      expect.objectContaining({ role: "user" }),
      { role: "assistant", content: SAFE_GREETING },
      { role: "user", content: "Who are you?" },
    ]);
    expect(JSON.stringify(client.requests[1])).not.toContain("partial unsafe text");
  });

  it("never sends the model an empty message, even from a Call stored with an empty greeting", async () => {
    const { engine, store, client } = openCall([say("Hello again.")]);
    await store.put({
      callId: "call-1",
      currentNodeId: "start",
      transcript: [{ role: "receptionist", text: "" }],
      variables: { ...flow.variables },
      turns: {},
      createdAt: 0,
      updatedAt: 0,
    });

    await engine.handleUser("call-1", "Hello?", "turn-1");

    const messages = client.requests[0]!.messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
    for (const message of messages) expect(message.content).not.toBe("");
  });
});
