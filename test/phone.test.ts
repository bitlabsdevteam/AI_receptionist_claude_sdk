import { beforeAll, describe, expect, it } from "vitest";
import { PhoneCalls } from "../src/adapters/phone.js";
import { FlowEngine } from "../src/engine/engine.js";
import type { ModelResponse } from "../src/engine/model.js";
import { InMemorySessionStore } from "../src/engine/session.js";
import { loadFlow } from "../src/flow/load.js";
import type { Flow } from "../src/flow/schema.js";
import { FakeClaude, GREETING, say, type ScriptedFailure } from "./fake-claude.js";
import { FakePhoneLine, settled } from "./fake-phone-line.js";

let flow: Flow;
beforeAll(async () => {
  flow = await loadFlow("flows/receptionist.json");
});

/** The line's id for the Call in most tests, and the number its Caller rings from. */
const CALL = "call-1";
const NUMBER = "+15551234567";

/** The phone Channel on a scripted model and a fake line, with everything it printed. */
function phoneWith(script: (ModelResponse | ScriptedFailure)[], callFlow: Flow = flow) {
  const client = new FakeClaude(script);
  const store = new InMemorySessionStore();
  const engine = new FlowEngine(callFlow, { client, store });
  const line = new FakePhoneLine();
  const writes: string[] = [];
  const phone = new PhoneCalls(engine, line, (text) => void writes.push(text));
  return { client, line, phone, output: () => writes.join(""), session: (callId: string = CALL) => store.get(callId) };
}

/**
 * Makes the model slow: every request waits until `answer()` lets the oldest one through. `asked()` counts the
 * requests made so far, answered or not.
 */
function holdModel(client: FakeClaude) {
  const waiting: (() => void)[] = [];
  let asked = 0;
  const createMessage = client.createMessage.bind(client);
  client.createMessage = async (request, onTextDelta) => {
    asked++;
    await new Promise<void>((resolve) => waiting.push(resolve));
    return createMessage(request, onTextDelta);
  };
  return {
    asked: () => asked,
    async answer(): Promise<void> {
      const next = waiting.shift();
      if (!next) throw new Error("The model has no request waiting for an answer");
      next();
      await settled();
    },
  };
}

describe("a call that arrives", () => {
  it("opens one Call under the line's id for it, with the Caller's number", async () => {
    const { phone, client, session } = phoneWith([say(GREETING)]);

    phone.callArrived(CALL, NUMBER);
    await settled();

    expect(client.requests).toHaveLength(1);
    expect((await session())?.callId).toBe(CALL);
    expect((await session())?.variables["caller_number"]).toBe(NUMBER);
  });

  it("opens nothing more when the arrival is reported again, even while the greeting is still being made", async () => {
    const { phone, client, output } = phoneWith([say(GREETING)]);
    const model = holdModel(client);

    phone.callArrived(CALL, NUMBER);
    phone.callArrived(CALL, NUMBER);
    await settled();
    expect(model.asked()).toBe(1);

    await model.answer();
    phone.callArrived(CALL, NUMBER);
    await settled();

    expect(model.asked()).toBe(1);
    expect(output()).not.toContain("already open");
  });

  it("passes a withheld number as nothing", async () => {
    const { phone, session } = phoneWith([say(GREETING), say(GREETING)]);

    phone.callArrived("call-1");
    phone.callArrived("call-2", " ");
    await settled();

    expect(await session("call-1")).toBeDefined();
    expect(Object.keys((await session("call-1"))?.variables ?? {})).not.toContain("caller_number");
    expect(Object.keys((await session("call-2"))?.variables ?? {})).not.toContain("caller_number");
  });
});

describe("the greeting", () => {
  it("is being made from the moment the call arrives, before the line connects", async () => {
    const { phone, client, line } = phoneWith([say(GREETING)]);

    phone.callArrived(CALL, NUMBER);
    await settled();

    expect(client.requests).toHaveLength(1);
    expect(line.said).toEqual([]);
  });

  it("is said once the line connects, when it was ready first", async () => {
    const { phone, line } = phoneWith([say(GREETING)]);

    phone.callArrived(CALL, NUMBER);
    await settled();
    phone.lineConnected(CALL);
    await settled();

    expect(line.said).toEqual([{ callId: CALL, text: GREETING }]);
  });

  it("is said once it is ready, when the line connected first", async () => {
    const { phone, client, line } = phoneWith([say(GREETING)]);
    const model = holdModel(client);

    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);
    await settled();
    expect(line.said).toEqual([]);

    await model.answer();

    expect(line.said).toEqual([{ callId: CALL, text: GREETING }]);
  });

  it("is said once, however often the connection is reported", async () => {
    const { phone, line } = phoneWith([say(GREETING)]);

    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);
    phone.lineConnected(CALL);
    await settled();
    phone.lineConnected(CALL);
    await settled();

    expect(line.saidOn(CALL)).toEqual([GREETING]);
  });
});

/** A Call whose Caller has just heard the greeting. `script` is what the model says after it. */
async function greetedCall(script: (ModelResponse | ScriptedFailure)[], callFlow: Flow = flow) {
  const made = phoneWith([say(GREETING), ...script], callFlow);
  made.phone.callArrived(CALL, NUMBER);
  made.phone.lineConnected(CALL);
  await settled();
  return made;
}

describe("what the Caller says", () => {
  it("becomes a Turn numbered from 1 under the Call's id, and its reply is said", async () => {
    const { phone, client, line, session } = await greetedCall([say("We are Acme Co."), say("Happy to help.")]);

    phone.callerSaid(CALL, "Who are you?");
    await settled();
    phone.callerSaid(CALL, "  Thanks.  ");
    await settled();

    expect(Object.keys((await session())?.turns ?? {})).toEqual(["call-1:1", "call-1:2"]);
    expect(client.requests[1]?.messages.at(-1)).toEqual({ role: "user", content: "Who are you?" });
    expect(client.requests[2]?.messages.at(-1)).toEqual({ role: "user", content: "Thanks." });
    expect(line.saidOn(CALL)).toEqual([GREETING, "We are Acme Co.", "Happy to help."]);
  });

  it("reaches nothing and spends no turn id when it is empty or only whitespace", async () => {
    const { phone, client, line, session } = await greetedCall([say("Hi there.")]);

    phone.callerSaid(CALL, "");
    phone.callerSaid(CALL, "  \n ");
    await settled();
    expect(client.requests).toHaveLength(1);
    expect((await session())?.transcript).toHaveLength(1);

    phone.callerSaid(CALL, "Hello");
    await settled();

    expect(Object.keys((await session())?.turns ?? {})).toEqual(["call-1:1"]);
    expect(line.saidOn(CALL)).toEqual([GREETING, "Hi there."]);
  });

  it("waits for the greeting when it arrives before the greeting is ready", async () => {
    const { phone, client, line, output, session } = phoneWith([say(GREETING), say("We are Acme Co.")]);
    const model = holdModel(client);
    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);

    phone.callerSaid(CALL, "Who are you?");
    await settled();
    expect(model.asked()).toBe(1);

    await model.answer();
    expect(line.saidOn(CALL)).toEqual([GREETING]);
    await model.answer();

    expect(line.saidOn(CALL)).toEqual([GREETING, "We are Acme Co."]);
    expect(Object.keys((await session())?.turns ?? {})).toEqual(["call-1:1"]);
    expect(output()).not.toContain("does not exist");
  });
});
