import { beforeAll, describe, expect, it } from "vitest";
import { FlowEngine, REFUSAL_LINE } from "../src/engine/engine.js";
import type { ReplyStream } from "../src/engine/reply-stream.js";
import { loadFlow } from "../src/flow/load.js";
import type { Flow } from "../src/flow/schema.js";
import { FakeClaude, GOODBYE_MESSAGE, GREETING, failAfter, flowWithBilling, reply, say, transition } from "./fake-claude.js";

let flow: Flow;
beforeAll(async () => {
  flow = await loadFlow("flows/receptionist.json");
});

/** Records what a terminal would be told, and the screen text it would be left showing. */
function recorder() {
  const events: ({ text: string } | "discard")[] = [];
  let screen = "";
  const stream: ReplyStream = {
    text(delta) {
      events.push({ text: delta });
      screen += delta;
    },
    discard() {
      events.push("discard");
      screen = "";
    },
  };
  return { stream, events, screen: () => screen };
}

describe("streaming the Receptionist's reply", () => {
  it("streams the greeting word by word, and the pieces add up to the reply", async () => {
    const { stream, events, screen } = recorder();
    const engine = new FlowEngine(flow, { client: new FakeClaude([say(GREETING)]) });

    const result = await engine.start("call-1", {}, stream);

    expect(events.length).toBeGreaterThan(5);
    expect(events).not.toContain("discard");
    expect(screen()).toBe(GREETING);
    expect(result.reply).toBe(GREETING);
  });

  it("streams a Turn's reply as it arrives", async () => {
    const { stream, screen } = recorder();
    const engine = new FlowEngine(flow, { client: new FakeClaude([say(GREETING), say("We are Acme Co. Anything else?")]) });
    await engine.start("call-1", {});

    const result = await engine.handleUser("call-1", "Who are you?", "turn-1", stream);

    expect(screen()).toBe("We are Acme Co. Anything else?");
    expect(result.reply).toBe(screen());
  });

  it("works with no stream, as before", async () => {
    const engine = new FlowEngine(flow, { client: new FakeClaude([say(GREETING), say("Hi.")]) });
    await engine.start("call-1", {});

    await expect(engine.handleUser("call-1", "Hello", "turn-1")).resolves.toMatchObject({ reply: "Hi." });
  });

  it("streams no stray whitespace around the text the model produced", async () => {
    const { stream, events, screen } = recorder();
    const engine = new FlowEngine(flow, { client: new FakeClaude([say("  Hello there.  \n")]) });

    const result = await engine.start("call-1", {}, stream);

    expect(result.reply).toBe("Hello there.");
    expect(screen()).toBe("Hello there.");
    expect(events[0]).toEqual({ text: "Hello" });
  });
});

describe("a Turn that takes an Edge", () => {
  it("streams text said before an Edge to another Node, then the next Node's text, as one continuous reply", async () => {
    const { stream, events, screen } = recorder();
    const engine = new FlowEngine(flowWithBilling(flow), {
      client: new FakeClaude([say(GREETING), transition("e_start_billing", "Happy to help."), say("What is the invoice number?")]),
    });
    await engine.start("call-1", {});

    const result = await engine.handleUser("call-1", "I have a billing question", "turn-1", stream);

    expect(events).not.toContain("discard");
    expect(screen()).toBe("Happy to help. What is the invoice number?");
    expect(result.reply).toBe(screen());
  });

  it("streams the End state's message after what the model said, once", async () => {
    const { stream, events, screen } = recorder();
    const engine = new FlowEngine(flow, { client: new FakeClaude([say(GREETING), transition("e_start_goodbye", "You're welcome.")]) });
    await engine.start("call-1", {});

    const result = await engine.handleUser("call-1", "That's all", "turn-1", stream);

    expect(events).not.toContain("discard");
    expect(screen()).toBe(`You're welcome. ${GOODBYE_MESSAGE}`);
    expect(result.reply).toBe(screen());
  });

  it("streams the End state's message when the model said nothing before the Edge", async () => {
    const { stream, screen } = recorder();
    const engine = new FlowEngine(flow, { client: new FakeClaude([say(GREETING), transition("e_start_goodbye")]) });
    await engine.start("call-1", {});

    await engine.handleUser("call-1", "Bye", "turn-1", stream);

    expect(screen()).toBe(GOODBYE_MESSAGE);
  });
});

describe("a Turn that is discarded", () => {
  it("retracts text streamed before a refusal, then shows the safe line instead", async () => {
    const { stream, events, screen } = recorder();
    const engine = new FlowEngine(flow, {
      client: new FakeClaude([say(GREETING), reply([{ type: "text", text: "Sure, here is how to" }], "refusal")]),
    });
    await engine.start("call-1", {});

    const result = await engine.handleUser("call-1", "Do something bad", "turn-1", stream);

    expect(events.filter((e) => e === "discard")).toHaveLength(1);
    expect(screen()).toBe(REFUSAL_LINE);
    expect(result.reply).toBe(REFUSAL_LINE);
  });

  it("retracts nothing when the refusal came with no text", async () => {
    const { stream, events, screen } = recorder();
    const engine = new FlowEngine(flow, { client: new FakeClaude([say(GREETING), reply([], "refusal")]) });
    await engine.start("call-1", {});

    await engine.handleUser("call-1", "Do something bad", "turn-1", stream);

    expect(events).not.toContain("discard");
    expect(screen()).toBe(REFUSAL_LINE);
  });

  it("retracts text from an earlier Node when a later Node in the same Turn refuses", async () => {
    const { stream, screen } = recorder();
    const engine = new FlowEngine(flowWithBilling(flow), {
      client: new FakeClaude([say(GREETING), transition("e_start_billing", "Happy to help."), reply([{ type: "text", text: "Well" }], "refusal")]),
    });
    await engine.start("call-1", {});

    await engine.handleUser("call-1", "billing please", "turn-1", stream);

    expect(screen()).toBe(REFUSAL_LINE);
  });

  it("retracts partial text when the model request fails mid-reply, and leaves the Call usable", async () => {
    const { stream, screen } = recorder();
    const engine = new FlowEngine(flow, {
      client: new FakeClaude([say(GREETING), failAfter("Let me che", new Error("connection reset")), say("Back again.")]),
    });
    await engine.start("call-1", {});

    await expect(engine.handleUser("call-1", "Hello?", "turn-1", stream)).rejects.toThrow("connection reset");
    expect(screen()).toBe("");

    const retry = recorder();
    const result = await engine.handleUser("call-1", "Hello?", "turn-2", retry.stream);
    expect(result.reply).toBe("Back again.");
    expect(retry.screen()).toBe("Back again.");
  });

  it("shows the empty-reply line when the model said nothing", async () => {
    const { stream, screen } = recorder();
    const engine = new FlowEngine(flow, { client: new FakeClaude([say(GREETING), reply([], "end_turn")]) });
    await engine.start("call-1", {});

    const result = await engine.handleUser("call-1", "Hello?", "turn-1", stream);

    expect(screen()).toBe(result.reply);
    expect(screen()).not.toBe("");
  });
});

describe("replaying a Turn", () => {
  it("shows the stored reply without calling the model again", async () => {
    const engine = new FlowEngine(flow, { client: new FakeClaude([say(GREETING), say("Hi.")]) });
    await engine.start("call-1", {});
    await engine.handleUser("call-1", "Hello", "turn-1");

    const { stream, screen } = recorder();
    await engine.handleUser("call-1", "Hello", "turn-1", stream);

    expect(screen()).toBe("Hi.");
  });
});
