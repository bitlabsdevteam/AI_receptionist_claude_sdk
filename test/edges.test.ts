import { beforeAll, describe, expect, it } from "vitest";
import { FlowEngine } from "../src/engine/engine.js";
import type { ContentBlock, ModelResponse } from "../src/engine/model.js";
import { InMemorySessionStore } from "../src/engine/session.js";
import { loadFlow } from "../src/flow/load.js";
import { parseFlow, type Flow } from "../src/flow/schema.js";
import { FakeClaude, reply, say } from "./fake-claude.js";

const GREETING = "Hello, this is Ava from Acme Co. How can I help you today?";
const GOODBYE_MESSAGE = "Thank you for calling. Goodbye.";
const DONE = "No, that's all, thanks.";

let flow: Flow;
beforeAll(async () => {
  flow = await loadFlow("flows/receptionist.json");
});

/** A scripted model reply that calls an Edge's transition tool, optionally with text before it. */
function transition(edgeId: string, text?: string): ModelResponse {
  const content: ContentBlock[] = [
    ...(text ? [{ type: "text" as const, text }] : []),
    { type: "tool_use", id: `toolu_${edgeId}`, name: `transition__${edgeId}`, input: { reason: "the caller said so" } },
  ];
  return reply(content, "tool_use");
}

async function openedCall(callFlow: Flow, ...script: ModelResponse[]) {
  const client = new FakeClaude([say(GREETING), ...script]);
  const store = new InMemorySessionStore();
  const engine = new FlowEngine(callFlow, { client, store });
  await engine.start("call-1", {});
  return { client, store, engine };
}

describe("the Caller says they are done", () => {
  it("reaches the goodbye End state and speaks its fixed message, even when the model produced no text", async () => {
    const { engine } = await openedCall(flow, transition("e_start_goodbye"));

    const result = await engine.handleUser("call-1", DONE, "turn-1");

    expect(result).toEqual({
      reply: GOODBYE_MESSAGE,
      nodeId: "goodbye",
      ended: true,
      endState: "goodbye",
      actions: [],
    });
  });

  it("offers the Edge to the model as a strict transition tool described by the Edge's condition", async () => {
    const { engine, client } = await openedCall(flow, transition("e_start_goodbye"));

    await engine.handleUser("call-1", DONE, "turn-1");

    const edge = flow.edges.find((e) => e.id === "e_start_goodbye")!;
    expect(client.requests[1]!.tools).toEqual([
      expect.objectContaining({
        name: "transition__e_start_goodbye",
        description: edge.condition.prompt,
        strict: true,
        inputSchema: expect.objectContaining({ type: "object", additionalProperties: false }),
      }),
    ]);
  });

  it("does not offer transition tools while greeting, because the Caller has not spoken", async () => {
    const { client } = await openedCall(flow);

    expect(client.requests[0]!.tools).toEqual([]);
  });

  it("speaks whatever the model said before taking the Edge, then the End state's message", async () => {
    const { engine, store } = await openedCall(flow, transition("e_start_goodbye", "You're welcome, Sam."));

    const result = await engine.handleUser("call-1", DONE, "turn-1");

    expect(result.reply).toBe(`You're welcome, Sam. ${GOODBYE_MESSAGE}`);
    expect((await store.get("call-1"))?.transcript.slice(-2)).toEqual([
      { role: "caller", text: DONE },
      { role: "receptionist", text: result.reply },
    ]);
  });

  it("fills Flow variables into the End state's message", async () => {
    const templated = structuredClone(flow);
    templated.end_states.goodbye!.message = "Thanks for calling {{company_name}}, goodbye.";
    const { engine } = await openedCall(templated, transition("e_start_goodbye"));

    expect((await engine.handleUser("call-1", DONE, "turn-1")).reply).toBe("Thanks for calling Acme Co., goodbye.");
  });

  it("marks the Call ended on the stored Call", async () => {
    const { engine, store } = await openedCall(flow, transition("e_start_goodbye"));

    await engine.handleUser("call-1", DONE, "turn-1");

    expect((await store.get("call-1"))?.endState).toBe("goodbye");
  });

  it("leaves the Call open when the model answers without taking the Edge", async () => {
    const { engine, store } = await openedCall(flow, say("We open at nine, I believe."));

    const result = await engine.handleUser("call-1", "Hi again", "turn-1");

    expect(result).toMatchObject({ nodeId: "start", ended: false, actions: [] });
    expect(result).not.toHaveProperty("endState");
    expect((await store.get("call-1"))?.endState).toBeUndefined();
  });

  it("takes the Edge over a business tool call in the same response, and runs no business tool", async () => {
    const both = reply(
      [
        { type: "tool_use", id: "toolu_1", name: "check_leave_balance", input: { employee_id: "E1001" } },
        { type: "tool_use", id: "toolu_2", name: "transition__e_start_goodbye", input: { reason: "done" } },
      ],
      "tool_use",
    );
    const { engine, client } = await openedCall(flow, both);

    const result = await engine.handleUser("call-1", DONE, "turn-1");

    expect(result).toMatchObject({ reply: GOODBYE_MESSAGE, ended: true, endState: "goodbye" });
    expect(client.requests).toHaveLength(2);
  });

  it("ignores a tool call that is not an Edge the Node offers", async () => {
    const bogus = reply([{ type: "tool_use", id: "toolu_1", name: "transition__e_nowhere", input: {} }], "tool_use");
    const { engine } = await openedCall(flow, bogus);

    const result = await engine.handleUser("call-1", DONE, "turn-1");

    expect(result).toMatchObject({ reply: "Sorry, could you say that again?", nodeId: "start", ended: false });
  });

  it("never takes an Edge from a refused response, and answers with the safe line", async () => {
    const refused = reply([{ type: "tool_use", id: "toolu_1", name: "transition__e_start_goodbye", input: {} }], "refusal");
    const { engine, store } = await openedCall(flow, refused);

    const result = await engine.handleUser("call-1", DONE, "turn-1");

    expect(result).toMatchObject({ nodeId: "start", ended: false });
    expect(result.reply).not.toContain(GOODBYE_MESSAGE);
    expect((await store.get("call-1"))?.endState).toBeUndefined();
  });
});

describe("a Call that has ended", () => {
  it("rejects a further Turn with a clear error, without calling the model or changing the Call", async () => {
    const { engine, client, store } = await openedCall(flow, transition("e_start_goodbye"), say("never used"));
    await engine.handleUser("call-1", DONE, "turn-1");
    const ended = await store.get("call-1");

    await expect(engine.handleUser("call-1", "Wait, one more thing", "turn-2")).rejects.toThrow(
      /Call "call-1" has ended \(goodbye\)/,
    );
    expect(client.requests).toHaveLength(2);
    expect(await store.get("call-1")).toEqual(ended);
  });

  it("still replays the Turn that ended it, so a webhook retry gets the goodbye again", async () => {
    const { engine, client } = await openedCall(flow, transition("e_start_goodbye"));
    const first = await engine.handleUser("call-1", DONE, "turn-1");

    expect(await engine.handleUser("call-1", DONE, "turn-1")).toEqual(first);
    expect(client.requests).toHaveLength(2);
  });

  it("is ended for another engine sharing the store, since the end is kept on the Call", async () => {
    const { engine, store } = await openedCall(flow, transition("e_start_goodbye"));
    await engine.handleUser("call-1", DONE, "turn-1");

    const other = new FlowEngine(flow, { client: new FakeClaude([]), store });

    await expect(other.handleUser("call-1", "Hello?", "turn-2")).rejects.toThrow(/has ended/);
  });
});

describe("an End state whose message cannot be spoken", () => {
  it("fails the Turn and leaves the Call open when the message uses an unknown variable", async () => {
    const broken = structuredClone(flow);
    broken.end_states.goodbye!.message = "Goodbye {{caller_name}}.";
    const { engine, store } = await openedCall(broken, transition("e_start_goodbye"));

    await expect(engine.handleUser("call-1", DONE, "turn-1")).rejects.toThrow(/caller_name/);
    const session = await store.get("call-1");
    expect(session?.endState).toBeUndefined();
    expect(session?.transcript).toHaveLength(1);
  });
});

/** The sample Flow plus a `billing` Node, to exercise Edges between Nodes. Only the goodbye Edge ships in the sample. */
function flowWithBilling(extraEdges: Flow["edges"] = []): Flow {
  return parseFlow({
    ...structuredClone(flow),
    nodes: [
      ...structuredClone(flow.nodes),
      {
        id: "billing",
        type: "prompt",
        effort: "medium",
        model: "anthropic/claude-haiku-5",
        instructions: "You now help with billing questions for {{company_name}}.",
      },
    ],
    edges: [
      ...structuredClone(flow.edges),
      {
        id: "e_start_billing",
        from: "start",
        to: "billing",
        condition: { type: "llm", prompt: "The caller asks about an invoice or payment." },
      },
      ...extraEdges,
    ],
  });
}

describe("an Edge to another Node", () => {
  const BILLING_QUESTION = "I have a question about my invoice.";

  it("re-runs the target Node on the same utterance and speaks both parts in one reply", async () => {
    const { engine, client } = await openedCall(
      flowWithBilling(),
      transition("e_start_billing", "Happy to help with that."),
      say("What would you like to know about it?"),
    );

    const result = await engine.handleUser("call-1", BILLING_QUESTION, "turn-1");

    expect(result).toEqual({
      reply: "Happy to help with that. What would you like to know about it?",
      nodeId: "billing",
      ended: false,
      actions: [],
    });
    expect(client.requests).toHaveLength(3);
    expect(client.requests[2]!.messages).toEqual(client.requests[1]!.messages);
    expect(client.requests[2]!.messages.at(-1)).toEqual({ role: "user", content: BILLING_QUESTION });
  });

  it("runs the target Node under its own instructions and model, and tells it what was already said", async () => {
    const { engine, client } = await openedCall(
      flowWithBilling(),
      transition("e_start_billing", "Happy to help with that."),
      say("What would you like to know about it?"),
    );

    await engine.handleUser("call-1", BILLING_QUESTION, "turn-1");

    const first = client.requests[1]!;
    const second = client.requests[2]!;
    expect(first.system).not.toContain("already said");
    expect(second.system).toContain("You now help with billing questions for Acme Co.");
    expect(second.system).not.toContain("Greet the caller warmly");
    expect(second.system).toContain("Happy to help with that.");
    expect(second).toMatchObject({ model: "claude-haiku-5", effort: "medium" });
  });

  it("offers the target Node its own Edges, not the previous Node's", async () => {
    const withBack = flowWithBilling([
      {
        id: "e_billing_start",
        from: "billing",
        to: "start",
        condition: { type: "llm", prompt: "The caller no longer needs billing help." },
      },
    ]);
    const { engine, client } = await openedCall(withBack, transition("e_start_billing"), say("Go ahead."));

    await engine.handleUser("call-1", BILLING_QUESTION, "turn-1");

    expect(client.requests[1]!.tools.map((t) => t.name)).toEqual([
      "transition__e_start_goodbye",
      "transition__e_start_billing",
    ]);
    expect(client.requests[2]!.tools.map((t) => t.name)).toEqual(["transition__e_billing_start"]);
  });

  it("leaves the Call on the target Node, so the next Turn starts there", async () => {
    const { engine, client, store } = await openedCall(
      flowWithBilling(),
      transition("e_start_billing"),
      say("Go ahead."),
      say("It was paid on the 3rd."),
    );
    await engine.handleUser("call-1", BILLING_QUESTION, "turn-1");

    const result = await engine.handleUser("call-1", "Was it paid?", "turn-2");

    expect(result.nodeId).toBe("billing");
    expect(client.requests[3]!.system).toContain("You now help with billing questions");
    expect((await store.get("call-1"))?.currentNodeId).toBe("billing");
  });

  it("can chain into an End state from the target Node in the same Turn", async () => {
    const chained = flowWithBilling([
      {
        id: "e_billing_goodbye",
        from: "billing",
        to: "goodbye",
        condition: { type: "llm", prompt: "The caller is done." },
      },
    ]);
    const { engine } = await openedCall(chained, transition("e_start_billing"), transition("e_billing_goodbye"));

    const result = await engine.handleUser("call-1", "Bye", "turn-1");

    expect(result).toMatchObject({ reply: GOODBYE_MESSAGE, nodeId: "goodbye", ended: true, endState: "goodbye" });
  });

  it("answers with a safe line when no Node along the way said anything", async () => {
    const { engine } = await openedCall(flowWithBilling(), transition("e_start_billing"), say(""));

    const result = await engine.handleUser("call-1", BILLING_QUESTION, "turn-1");

    expect(result).toMatchObject({ reply: "Sorry, could you say that again?", nodeId: "billing", ended: false });
  });

  it("discards what was said and stays put when a later Node refuses", async () => {
    const { engine, store } = await openedCall(
      flowWithBilling(),
      transition("e_start_billing", "Happy to help with that."),
      reply([], "refusal"),
    );

    const result = await engine.handleUser("call-1", BILLING_QUESTION, "turn-1");

    expect(result).toMatchObject({ nodeId: "start", ended: false });
    expect(result.reply).not.toContain("Happy to help");
    expect((await store.get("call-1"))?.currentNodeId).toBe("start");
  });
});

describe("max_hops", () => {
  const loop = () =>
    flowWithBilling([
      {
        id: "e_billing_start",
        from: "billing",
        to: "start",
        condition: { type: "llm", prompt: "The caller no longer needs billing help." },
      },
    ]);
  const pingPong = [
    transition("e_start_billing", "One."),
    transition("e_billing_start", "Two."),
    transition("e_start_billing", "Three."),
    transition("e_billing_start", "Four."),
    say("never used"),
  ];

  it("stops a routing loop after 4 Nodes by default, staying on the last Node that ran and speaking what was said", async () => {
    const { engine, client } = await openedCall(loop(), ...pingPong);

    const result = await engine.handleUser("call-1", "Round and round", "turn-1");

    expect(client.requests).toHaveLength(1 + 4);
    expect(result).toMatchObject({ reply: "One. Two. Three. Four.", nodeId: "billing", ended: false });
  });

  it("honours a lower limit set on the engine", async () => {
    const client = new FakeClaude([say(GREETING), ...pingPong]);
    const engine = new FlowEngine(loop(), { client, maxHops: 2 });
    await engine.start("call-1", {});

    const result = await engine.handleUser("call-1", "Round and round", "turn-1");

    expect(client.requests).toHaveLength(1 + 2);
    expect(result).toMatchObject({ reply: "One. Two.", nodeId: "billing" });
  });

  it("still ends the Call when the last permitted hop takes an Edge to an End state", async () => {
    const client = new FakeClaude([say(GREETING), transition("e_start_goodbye")]);
    const engine = new FlowEngine(loop(), { client, maxHops: 1 });
    await engine.start("call-1", {});

    expect(await engine.handleUser("call-1", DONE, "turn-1")).toMatchObject({ ended: true, endState: "goodbye" });
  });

  it("rejects a limit that is not a positive integer", () => {
    for (const maxHops of [0, -1, 1.5, Number.NaN]) {
      expect(() => new FlowEngine(flow, { client: new FakeClaude([]), maxHops })).toThrow(/maxHops/);
    }
  });
});
