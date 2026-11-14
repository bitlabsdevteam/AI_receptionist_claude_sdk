import { beforeAll, describe, expect, it } from "vitest";
import { FlowEngine } from "../src/engine/engine.js";
import { InMemorySessionStore } from "../src/engine/session.js";
import { loadFlow } from "../src/flow/load.js";
import type { Flow } from "../src/flow/schema.js";
import { FakeClaude, say } from "./fake-claude.js";

const GREETING = "Hello, this is Ava from Acme Co. How can I help you today?";

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
      assistant_name: "Ava",
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
