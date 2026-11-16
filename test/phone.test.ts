import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PhoneCalls } from "../src/adapters/phone.js";
import { FlowEngine, REFUSAL_LINE } from "../src/engine/engine.js";
import type { ModelResponse } from "../src/engine/model.js";
import { InMemorySessionStore } from "../src/engine/session.js";
import { loadFlow } from "../src/flow/load.js";
import type { Flow } from "../src/flow/schema.js";
import { FakeClaude, GOODBYE_MESSAGE, GREETING, failAfter, goodbye, flowWithBilling, reply, say, transition, type ScriptedFailure } from "./fake-claude.js";
import { FakeClock } from "./fake-clock.js";
import { FakePhoneLine, settled } from "./fake-phone-line.js";

let flow: Flow;
beforeAll(async () => {
  flow = await loadFlow("flows/receptionist.json");
});

/** The line's id for the Call in most tests, and the number its Caller rings from. */
const CALL = "call-1";
const NUMBER = "+15551234567";

/** The phone Channel on a scripted model and a fake line, with everything it printed. */
function phoneWith(
  script: (ModelResponse | ScriptedFailure)[],
  callFlow: Flow = flow,
  clock?: () => number,
  after?: (ms: number, run: () => void) => () => void,
) {
  const client = new FakeClaude(script);
  const store = new InMemorySessionStore();
  const engine = new FlowEngine(callFlow, { client, store });
  const line = new FakePhoneLine();
  const writes: string[] = [];
  const phone = new PhoneCalls(engine, line, (text) => void writes.push(text), {
    ...(clock ? { clock } : {}),
    ...(after ? { after } : {}),
  });
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
      await settled();
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

  it("waits for the line to connect when it arrives before that, and is said after the greeting", async () => {
    const { phone, line, session } = phoneWith([say(GREETING), say("We are Acme Co.")]);
    phone.callArrived(CALL, NUMBER);

    phone.callerSaid(CALL, "Who are you?");
    await settled();
    // Nothing can be said while the line has not connected, but the Turn is not lost.
    expect(line.said).toEqual([]);

    phone.lineConnected(CALL);
    await settled();

    expect(line.saidOn(CALL)).toEqual([GREETING, "We are Acme Co."]);
    expect(Object.keys((await session())?.turns ?? {})).toEqual(["call-1:1"]);
  });
});

describe("what the line is asked to say", () => {
  it("is handed over only after the Turn has finished, never while its text streams", async () => {
    const made = phoneWith([say(GREETING), say("We are Acme Co. We are open nine to five.")]);
    // When the line is asked to say a reply, the Turn that made it must already be on the Call's record.
    const recorded: boolean[] = [];
    const say_ = made.line.say.bind(made.line);
    made.line.say = (callId, text) => {
      void made.session(callId).then((session) => recorded.push(Object.keys(session?.turns ?? {}).length > 0));
      say_(callId, text);
    };
    let streamed = 0;
    const createMessage = made.client.createMessage.bind(made.client);
    made.client.createMessage = (request, onTextDelta) =>
      createMessage(request, (delta) => {
        // Whatever has been handed to the line while words are still arriving, none of it is of the reply being made.
        if (made.line.said.length > 0) {
          streamed++;
          expect(made.line.saidOn(CALL)).toEqual([GREETING]);
        }
        onTextDelta?.(delta);
      });
    made.phone.callArrived(CALL, NUMBER);
    made.phone.lineConnected(CALL);
    await settled();

    made.phone.callerSaid(CALL, "Who are you?");
    await settled();

    expect(streamed).toBeGreaterThan(0);
    expect(made.line.saidOn(CALL)).toEqual([GREETING, "We are Acme Co. We are open nine to five."]);
    expect(recorded.at(-1)).toBe(true);
  });

  it("is the finished Turn's whole reply, once, when the Turn ran more than one Node", async () => {
    const { phone, line } = await greetedCall(
      [transition("e_start_billing", "One moment."), say("Let me look at that invoice.")],
      flowWithBilling(flow),
    );

    phone.callerSaid(CALL, "I have a question about my invoice.");
    await settled();

    expect(line.saidOn(CALL)).toEqual([GREETING, "One moment. Let me look at that invoice."]);
  });

  it("is the safe line alone when the model refuses, never the text that streamed before the refusal", async () => {
    const { phone, line } = await greetedCall([reply([{ type: "text", text: "Sure, here is how to do it" }], "refusal")]);

    phone.callerSaid(CALL, "Something awful");
    await settled();

    expect(line.saidOn(CALL)).toEqual([GREETING, REFUSAL_LINE]);
  });

  it("is the safe greeting alone when the model refuses the greeting", async () => {
    const { phone, line } = phoneWith([reply([{ type: "text", text: "I cannot take this call" }], "refusal")]);

    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);
    await settled();

    expect(line.saidOn(CALL)).toHaveLength(1);
    expect(line.saidOn(CALL)[0]).toContain("Ava");
    expect(line.saidOn(CALL)[0]).not.toContain("cannot take this call");
  });

  it("is nothing from a Turn that failed after text had streamed, and the Call carries on", async () => {
    const { phone, line, output, session } = await greetedCall([
      failAfter("We are", new Error("connection lost")),
      say("We are Acme Co."),
    ]);

    phone.callerSaid(CALL, "Who are you?");
    await settled();
    expect(line.saidOn(CALL)).toEqual([GREETING]);
    expect(output()).toContain("(The Receptionist could not answer: connection lost)\n");

    phone.callerSaid(CALL, "Who are you?");
    await settled();

    expect(line.saidOn(CALL)).toEqual([GREETING, "We are Acme Co."]);
    // The failed Turn was not recorded, so it spent no turn id.
    expect(Object.keys((await session())?.turns ?? {})).toEqual(["call-1:1"]);
  });

  it("is nothing when the greeting could not be made, and nothing the Caller then says starts a Turn", async () => {
    const { phone, client, line, output } = phoneWith([failAfter("Hello, this", new Error("overloaded"))]);

    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);
    await settled();
    phone.callerSaid(CALL, "Hello?");
    phone.callArrived(CALL, NUMBER);
    await settled();

    expect(line.said).toEqual([]);
    expect(client.requests).toHaveLength(1);
    expect(output()).toContain("Could not open the Call: overloaded\n");
  });

  it("costs one printed line when the line cannot say it, and the Call carries on", async () => {
    const { phone, line, output, session } = await greetedCall([say("We are Acme Co."), say("Happy to help.")]);
    line.failures.push(new Error("the line is busy"));

    phone.callerSaid(CALL, "Who are you?");
    phone.callerSaid(CALL, "Thanks.");
    await settled();

    expect(output().match(/Could not say/g)).toHaveLength(1);
    expect(output()).toContain("(Could not say the reply: the line is busy)\n");
    expect(line.saidOn(CALL)).toEqual([GREETING, "Happy to help."]);
    expect(Object.keys((await session())?.turns ?? {})).toEqual(["call-1:1", "call-1:2"]);
  });
});

describe("two things said in quick succession", () => {
  it("are two Turns, one at a time, and two replies in order", async () => {
    const { phone, client, line, session } = phoneWith([say(GREETING), say("We are Acme Co."), say("Nine to five.")]);
    const model = holdModel(client);
    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);
    await model.answer();

    phone.callerSaid(CALL, "Who are you?");
    phone.callerSaid(CALL, "And your hours?");
    await settled();
    // The second Turn has not started: the model has been asked for the greeting and the first Turn only.
    expect(model.asked()).toBe(2);

    await model.answer();
    expect(line.saidOn(CALL)).toEqual([GREETING, "We are Acme Co."]);
    await model.answer();

    expect(line.saidOn(CALL)).toEqual([GREETING, "We are Acme Co.", "Nine to five."]);
    expect(Object.keys((await session())?.turns ?? {})).toEqual(["call-1:1", "call-1:2"]);
    expect(client.requests[2]?.messages.slice(-3)).toEqual([
      { role: "user", content: "Who are you?" },
      { role: "assistant", content: "We are Acme Co." },
      { role: "user", content: "And your hours?" },
    ]);
  });
});

describe("an interruption", () => {
  it("is printed and changes nothing in the engine", async () => {
    const { phone, client, line, output, session } = await greetedCall([say("We are Acme Co."), say("Nine to five.")]);
    phone.callerSaid(CALL, "Who are you?");
    await settled();
    const before = await session();

    phone.callerInterrupted(CALL);
    await settled();

    expect(output().match(/\(The Caller interrupted\.\)\n/g)).toHaveLength(1);
    expect(await session()).toEqual(before);
    expect(client.requests).toHaveLength(2);
    expect(line.saidOn(CALL)).toEqual([GREETING, "We are Acme Co."]);

    phone.callerSaid(CALL, "And your hours?");
    await settled();
    expect(line.saidOn(CALL)).toEqual([GREETING, "We are Acme Co.", "Nine to five."]);
    expect(Object.keys((await session())?.turns ?? {})).toEqual(["call-1:1", "call-1:2"]);
  });

  it("leaves a Turn in flight to finish and be said", async () => {
    const { phone, client, line } = phoneWith([say(GREETING), say("We are Acme Co.")]);
    const model = holdModel(client);
    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);
    await model.answer();
    phone.callerSaid(CALL, "Who are you?");
    await settled();

    phone.callerInterrupted(CALL);
    await model.answer();

    expect(line.saidOn(CALL)).toEqual([GREETING, "We are Acme Co."]);
  });

  it("is not printed for a Call that never arrived", async () => {
    const { phone, output } = phoneWith([]);

    phone.callerInterrupted("call-9");

    expect(output()).toBe("");
  });
});

describe("when the Caller hangs up", () => {
  it("lets a Turn in flight finish, but does not say its reply", async () => {
    const { phone, client, line, output, session } = phoneWith([say(GREETING), say("We are Acme Co.")]);
    const model = holdModel(client);
    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);
    await model.answer();
    phone.callerSaid(CALL, "Who are you?");
    await settled();

    phone.callerHungUp(CALL);
    await model.answer();

    expect(line.saidOn(CALL)).toEqual([GREETING]);
    expect((await session())?.turns["call-1:1"]?.reply).toBe("We are Acme Co.");
    // The reply reached nobody, so it is not printed as said and has no timing line.
    expect(output().endsWith("Caller: Who are you?\nThe Caller hung up.\n")).toBe(true);
  });

  it("starts no Turn that was waiting behind the one in flight", async () => {
    const { phone, client, line, session } = phoneWith([say(GREETING), say("We are Acme Co."), say("Nine to five.")]);
    const model = holdModel(client);
    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);
    await model.answer();
    phone.callerSaid(CALL, "Who are you?");
    phone.callerSaid(CALL, "And your hours?");
    await settled();

    phone.callerHungUp(CALL);
    await model.answer();
    await settled();

    expect(model.asked()).toBe(2);
    expect(line.saidOn(CALL)).toEqual([GREETING]);
    expect(Object.keys((await session())?.turns ?? {})).toEqual(["call-1:1"]);
  });

  it("does not say a greeting that was still being made", async () => {
    const { phone, client, line } = phoneWith([say(GREETING)]);
    const model = holdModel(client);
    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);

    phone.callerHungUp(CALL);
    await model.answer();

    expect(line.said).toEqual([]);
  });

  it("does not say a greeting that was waiting for the line to connect", async () => {
    const { phone, line } = phoneWith([say(GREETING)]);
    phone.callArrived(CALL, NUMBER);
    await settled();

    phone.callerHungUp(CALL);
    phone.lineConnected(CALL);
    await settled();

    expect(line.said).toEqual([]);
  });

  it("ignores whatever the line reports for the Call afterwards", async () => {
    const { phone, client, line, output, session } = await greetedCall([say("We are Acme Co.")]);
    phone.callerHungUp(CALL);
    const printed = output();
    const before = await session();

    phone.callerSaid(CALL, "Who are you?");
    phone.callerInterrupted(CALL);
    phone.lineConnected(CALL);
    phone.callArrived(CALL, NUMBER);
    phone.callerHungUp(CALL);
    await settled();

    expect(client.requests).toHaveLength(1);
    expect(line.saidOn(CALL)).toEqual([GREETING]);
    expect(output()).toBe(printed);
    expect(await session()).toEqual(before);
  });
});

describe("several Calls at once", () => {
  it("each keep their own greeting, Turns and replies, whatever happens on the others", async () => {
    // The model answers in the order it is let through below, which is the order of this script.
    const { phone, client, line, session } = phoneWith([
      say("Hello, first Caller."),
      say("Hello, second Caller."),
      say("A reply nobody hears."),
      say("We are Acme Co."),
      failAfter("Nine", new Error("connection lost")),
      say("Nine to five."),
    ]);
    const model = holdModel(client);

    phone.callArrived("call-1", "+15550001111");
    phone.callArrived("call-2", "+15550002222");
    phone.lineConnected("call-2");
    phone.lineConnected("call-1");
    await model.answer();
    await model.answer();
    expect(line.said).toEqual([
      { callId: "call-1", text: "Hello, first Caller." },
      { callId: "call-2", text: "Hello, second Caller." },
    ]);

    // Both Callers speak, and both Turns are in flight together. Then the first Caller hangs up.
    phone.callerSaid("call-1", "Is anyone there?");
    phone.callerSaid("call-2", "Who are you?");
    await settled();
    expect(model.asked()).toBe(4);
    phone.callerHungUp("call-1");
    await model.answer();
    await model.answer();

    // The second Call carries on, through a Turn of its own that fails.
    phone.callerSaid("call-2", "And your hours?");
    await model.answer();
    phone.callerSaid("call-2", "And your hours?");
    await model.answer();

    expect(line.saidOn("call-1")).toEqual(["Hello, first Caller."]);
    expect(line.saidOn("call-2")).toEqual(["Hello, second Caller.", "We are Acme Co.", "Nine to five."]);
    expect(Object.keys((await session("call-1"))?.turns ?? {})).toEqual(["call-1:1"]);
    expect(Object.keys((await session("call-2"))?.turns ?? {})).toEqual(["call-2:1", "call-2:2"]);
    expect((await session("call-1"))?.variables["caller_number"]).toBe("+15550001111");
    expect((await session("call-2"))?.variables["caller_number"]).toBe("+15550002222");
    expect(JSON.stringify((await session("call-2"))?.transcript)).not.toContain("Is anyone there?");
  });
});

describe("what is printed", () => {
  /** A phone on a fake clock, which moves only when the model answers: every answer takes `modelMs`. */
  function timedPhone(script: (ModelResponse | ScriptedFailure)[], modelMs: number, callFlow: Flow = flow) {
    let now = 5000;
    const made = phoneWith(script, callFlow, () => now);
    const createMessage = made.client.createMessage.bind(made.client);
    made.client.createMessage = async (request, onTextDelta) => {
      try {
        return await createMessage(request, onTextDelta);
      } finally {
        now += modelMs;
      }
    };
    return made;
  }

  it("is the Call arriving, the greeting, each Turn's words on both sides and its timing, and the hang-up", async () => {
    const { phone, output } = timedPhone([say(GREETING), say("We are Acme Co.")], 450);

    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);
    await settled();
    phone.callerSaid(CALL, "  Who are you? ");
    await settled();
    phone.callerHungUp(CALL);

    expect(output()).toBe(
      "Call arrived from a number ending 4567.\n" +
        `Receptionist: ${GREETING}\n` +
        "Caller: Who are you?\n" +
        "Receptionist: We are Acme Co.\n" +
        "(Timing: reply 450 ms)\n" +
        "The Caller hung up.\n",
    );
  });

  it("says that the number was withheld when the Call arrives without one", async () => {
    const { phone, output } = phoneWith([say(GREETING)]);

    phone.callArrived(CALL);
    phone.callArrived(CALL);
    await settled();

    expect(output()).toBe("Call arrived from a withheld number.\n");
  });

  it("never holds the Caller's whole number, whatever happens on the Call", async () => {
    const { phone, output } = phoneWith([
      say(GREETING),
      say("We are Acme Co."),
      failAfter("Nine", new Error("connection lost")),
    ]);

    phone.callArrived(CALL, "+1 (555) 123-4567");
    phone.callArrived(CALL, "+1 (555) 123-4567");
    phone.lineConnected(CALL);
    phone.callerSaid(CALL, "Who are you?");
    phone.callerInterrupted(CALL);
    phone.callerSaid(CALL, "And your hours?");
    await settled();
    phone.callerHungUp(CALL);

    expect(output().match(/Call arrived/g)).toHaveLength(1);
    expect(output()).toContain("Call arrived from a number ending 4567.\n");
    expect(output()).toContain("could not answer");
    expect(output()).not.toContain("555");
    expect(output().replace(/\D/g, "")).not.toContain("1234567");
  });

  it("shows no digit of a number too short to hide behind its last four", async () => {
    const { phone, output } = phoneWith([say(GREETING), say(GREETING)]);

    phone.callArrived("call-1", "4567");
    phone.callArrived("call-2", "911");
    await settled();

    expect(output()).toBe("Call arrived from a short number.\nCall arrived from a short number.\n");
  });

  it("times a Turn from its utterance arriving, so a Turn that waited behind another shows the wait", async () => {
    const { phone, output } = timedPhone([say(GREETING), say("We are Acme Co."), say("Nine to five.")], 450);
    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);
    await settled();

    phone.callerSaid(CALL, "Who are you?");
    phone.callerSaid(CALL, "And your hours?");
    await settled();

    expect(output()).toContain(
      "Caller: Who are you?\n" +
        "Receptionist: We are Acme Co.\n" +
        "(Timing: reply 450 ms)\n" +
        "Caller: And your hours?\n" +
        "Receptionist: Nine to five.\n" +
        "(Timing: reply 900 ms)\n",
    );
  });

  it("has one timing line per reply said: none for the greeting, an empty utterance, a failed Turn or a reply the line could not take", async () => {
    const { phone, line, output } = timedPhone(
      [say(GREETING), failAfter("We are", new Error("connection lost")), say("We are Acme Co."), say("Happy to help.")],
      449.6,
    );
    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);
    await settled();
    expect(output()).not.toContain("Timing");

    phone.callerSaid(CALL, "  ");
    phone.callerSaid(CALL, "Who are you?");
    await settled();
    expect(output()).not.toContain("Timing");

    phone.callerSaid(CALL, "Who are you?");
    await settled();
    line.failures.push(new Error("the line is busy"));
    phone.callerSaid(CALL, "Thanks.");
    await settled();

    expect(output().match(/\(Timing: /g)).toHaveLength(1);
    expect(output()).toContain("Receptionist: We are Acme Co.\n(Timing: reply 450 ms)\n");
    expect(output().endsWith("Receptionist: Happy to help.\n(Could not say the reply: the line is busy)\n")).toBe(true);
  });
});

describe("an ending Turn", () => {
  it("closes the line with the whole reply, once, and does not say it the normal way", async () => {
    const { phone, line } = await greetedCall([goodbye("Happy to help.")]);

    phone.callerSaid(CALL, "Goodbye");
    await settled();

    expect(line.closed).toEqual([{ callId: CALL, text: `Happy to help. ${GOODBYE_MESSAGE}` }]);
    expect(line.saidOn(CALL)).toEqual([GREETING]);
  });

  it("speaks the End state's message exactly once, even when the model said nothing of its own", async () => {
    const { phone, line, session } = await greetedCall([goodbye()]);

    phone.callerSaid(CALL, "Goodbye");
    await settled();

    expect(line.closed).toEqual([{ callId: CALL, text: GOODBYE_MESSAGE }]);
    const spoken = [...line.saidOn(CALL), ...line.closed.map((closed) => closed.text)].join(" ");
    expect(spoken.split(GOODBYE_MESSAGE)).toHaveLength(2);
    expect((await session())?.endState).toBe("goodbye");
  });

  it("starts no Turn after it, including one that was waiting behind it, and says nothing more", async () => {
    const { phone, client, line, session } = phoneWith([say(GREETING), goodbye(), say("Nine to five.")]);
    const model = holdModel(client);
    phone.callArrived(CALL, NUMBER);
    phone.lineConnected(CALL);
    await model.answer();
    phone.callerSaid(CALL, "Goodbye");
    phone.callerSaid(CALL, "And your hours?");
    await settled();

    await model.answer();
    phone.callerSaid(CALL, "Hello?");
    await settled();

    expect(model.asked()).toBe(2);
    expect(line.closed).toHaveLength(1);
    expect(line.saidOn(CALL)).toEqual([GREETING]);
    expect(Object.keys((await session())?.turns ?? {})).toEqual(["call-1:1"]);
  });
});

describe("the phone line seam", () => {
  it("keeps src/adapters/phone.ts free of Telnyx: none of its names, and no import from src/telnyx/", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/adapters/phone.ts", import.meta.url)), "utf8");
    // Every module the file names, whether after `from`, in a bare `import "..."` or in an `import("...")`.
    const imported = [...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);

    expect(imported).toContain("../engine/engine.js");
    expect(imported.filter((module) => module?.toLowerCase().includes("telnyx"))).toEqual([]);
    // Comments count too: the rules of a phone Call are worded without the provider.
    expect(source.match(/telnyx|webhook|frame|socket|relay/gi) ?? []).toEqual([]);
  });
});
