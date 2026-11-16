import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import type { ChatIO } from "../src/adapters/chat.js";
import { runTalk } from "../src/adapters/talk.js";
import { FlowEngine, REFUSAL_LINE } from "../src/engine/engine.js";
import { InMemorySessionStore } from "../src/engine/session.js";
import { VoiceError, VoiceInterrupted } from "../src/voice/voice.js";
import type { ModelResponse } from "../src/engine/model.js";
import { loadFlow } from "../src/flow/load.js";
import type { Flow } from "../src/flow/schema.js";
import { FakeClaude, GOODBYE_MESSAGE, GREETING, goodbye, reply, say, type ScriptedFailure } from "./fake-claude.js";
import { FakeVoice, type Heard } from "./fake-voice.js";

let flow: Flow;
beforeAll(async () => {
  flow = await loadFlow("flows/receptionist.json");
});

/** A Caller at the keyboard who types `lines` (an empty line is Enter, meaning "I will speak") and then closes the input. */
function terminal(lines: string[]) {
  const writes: string[] = [];
  const queue = [...lines];
  const io: ChatIO = {
    write: (text) => void writes.push(text),
    async ask(prompt) {
      writes.push(prompt);
      const line = queue.shift();
      if (line !== undefined) writes.push(`${line}\n`);
      return line;
    },
  };
  return { io, output: () => writes.join("") };
}

function call(script: (ModelResponse | ScriptedFailure)[], heard: Heard[] = [], speakFailures: Error[] = []) {
  const client = new FakeClaude(script);
  const store = new InMemorySessionStore();
  const engine = new FlowEngine(flow, { client, store });
  const voice = new FakeVoice(heard, speakFailures);
  return { client, engine, voice, session: () => store.get("terminal") };
}

describe("opening the spoken Call", () => {
  it("prints and speaks the greeting before asking the Caller for anything", async () => {
    const { engine, voice } = call([say(GREETING)]);
    const { io, output } = terminal([]);

    await runTalk(engine, voice, io);

    expect(voice.spoken).toEqual([GREETING]);
    expect(output().startsWith(`Receptionist: ${GREETING}\n`)).toBe(true);
    expect(voice.listens).toBe(0);
  });
});

describe("talking", () => {
  it("listens when the Caller presses Enter, shows what was heard, and prints and speaks the reply once", async () => {
    const { engine, voice, client } = call([say(GREETING), say("We are Acme Co.")], ["Who are you?"]);
    const { io, output } = terminal([""]);

    const result = await runTalk(engine, voice, io);

    expect(voice.spoken).toEqual([GREETING, "We are Acme Co."]);
    expect(output()).toBe(
      `Receptionist: ${GREETING}\nYou (Enter to speak, or type): \nYou: Who are you?\nReceptionist: We are Acme Co.\nYou (Enter to speak, or type): `,
    );
    expect(client.requests).toHaveLength(2);
    expect(result).toBe("input-closed");
  });

  it("accepts a typed line without listening", async () => {
    const { engine, voice } = call([say(GREETING), say("Happy to help.")]);

    await runTalk(engine, voice, terminal(["What are your hours?"]).io);

    expect(voice.listens).toBe(0);
    expect(voice.spoken).toEqual([GREETING, "Happy to help."]);
  });

  it("sends the Caller's trimmed words to the model", async () => {
    const { engine, voice, client } = call([say(GREETING), say("Sure.")], ["  I need an invoice.  "]);

    await runTalk(engine, voice, terminal([""]).io);

    expect(JSON.stringify(client.requests[1]?.messages)).toContain('"I need an invoice."');
  });

  it("speaks the reply only after it has finished printing, never while it streams", async () => {
    const events: string[] = [];
    const { engine, voice } = call([say(GREETING), say("We are Acme Co. Ask away.")]);
    const speak = voice.speak.bind(voice);
    voice.speak = async (text) => {
      events.push(`speak:${text}`);
      await speak(text);
    };
    let asks = 0;
    const io: ChatIO = {
      write: (text) => void events.push(`write:${text}`),
      ask: async () => (asks++ === 0 ? "Hi" : undefined),
    };

    await runTalk(engine, voice, io);

    const at = events.indexOf("speak:We are Acme Co. Ask away.");
    expect(at).toBeGreaterThan(-1);
    expect(events.slice(0, at).filter((e) => e.startsWith("write:")).join("").replaceAll("write:", "")).toContain("We are Acme Co. Ask away.\n");
    expect(events.slice(at + 1).join("")).not.toContain("Acme");
  });
});

describe("when the Voice cannot speak", () => {
  it("prints one line, still shows the reply, and carries on with the Call", async () => {
    const { engine, voice, client } = call([say(GREETING), say("We are Acme Co."), say("Happy to help.")], [], [
      new VoiceError("playback failed"),
    ]);
    const { io, output } = terminal(["Who are you?", "Thanks."]);

    const result = await runTalk(engine, voice, io);

    // The greeting could not be spoken, but it was printed and the Call went on.
    expect(output()).toContain(`Receptionist: ${GREETING}\n(Could not speak: playback failed)\n`);
    expect(output().match(/Could not speak/g)).toHaveLength(1);
    expect(voice.spoken).toEqual(["We are Acme Co.", "Happy to help."]);
    expect(result).toBe("input-closed");
    expect(client.requests).toHaveLength(3);
  });

  it("leaves the Turn result alone, keeps the Call open, and never tells the model", async () => {
    const { engine, voice, client, session: getSession } = call([say(GREETING), say("We are Acme Co."), say("Anything else?")], [], [
      new VoiceError("no audio device"),
      new VoiceError("no audio device"),
    ]);
    const { io, output } = terminal(["Who are you?", "Nothing."]);

    const result = await runTalk(engine, voice, io);

    expect(output()).toContain("Receptionist: We are Acme Co.\n(Could not speak: no audio device)\n");
    expect(output()).not.toContain("could not answer");
    const session = await getSession();
    expect(session?.endState).toBeUndefined();
    expect(session?.turns["turn-1"]?.reply).toBe("We are Acme Co.");
    expect(result).toBe("input-closed");
    expect(JSON.stringify(client.requests.map((r) => r.messages))).not.toContain("no audio device");
  });

  it("still ends the Call, as the Turn result says, when the End state's message cannot be spoken", async () => {
    const { engine, voice } = call([say(GREETING), goodbye()], [], [new VoiceError("x"), new VoiceError("no audio device")]);
    const { io, output } = terminal(["Bye"]);

    const result = await runTalk(engine, voice, io);

    expect(output()).toContain(`Receptionist: ${GOODBYE_MESSAGE}\n(Could not speak: no audio device)\n`);
    expect(result).toBe("ended");
  });
});

describe("an empty transcript", () => {
  it("is answered locally and re-prompts without calling the model", async () => {
    const { engine, voice, client } = call([say(GREETING)], ["", "   "]);
    const { io, output } = terminal(["", ""]);

    await runTalk(engine, voice, io);

    expect(client.requests).toHaveLength(1);
    expect(output().match(/I didn't catch that/g)).toHaveLength(2);
    expect(voice.listens).toBe(2);
  });

  it("spends no turn id, so the next heard Turn is turn-1", async () => {
    const { engine, voice, client, session: getSession } = call([say(GREETING), say("Hi there.")], ["", "Hello"]);

    await runTalk(engine, voice, terminal(["", ""]).io);

    const session = await getSession();
    expect(client.requests).toHaveLength(2);
    expect(JSON.stringify(client.requests[1]?.messages)).toContain('"Hello"');
    expect(Object.keys(session?.turns ?? {})).toEqual(["turn-1"]);
  });

  it("says nothing aloud", async () => {
    const { engine, voice, client } = call([say(GREETING)], [""]);

    await runTalk(engine, voice, terminal([""]).io);

    expect(client.requests).toHaveLength(1);
    expect(voice.spoken).toEqual([GREETING]);
  });
});

describe("when the Voice cannot listen", () => {
  it("prints a notice and lets the Caller try again without calling the model", async () => {
    const { engine, voice, client } = call([say(GREETING), say("Hi there.")], [new VoiceError("microphone busy"), "Hello"]);
    const { io, output } = terminal(["", ""]);

    const result = await runTalk(engine, voice, io);

    expect(output()).toContain("(Could not hear you: microphone busy. Please try again.)\n");
    expect(voice.spoken).toEqual([GREETING, "Hi there."]);
    expect(client.requests).toHaveLength(2);
    expect(result).toBe("input-closed");
  });

  it("ends the Call when the Caller interrupts", async () => {
    const { engine, voice, client } = call([say(GREETING)], [new VoiceInterrupted()]);

    const result = await runTalk(engine, voice, terminal([""]).io);

    expect(result).toBe("interrupted");
    expect(client.requests).toHaveLength(1);
  });
});

describe("what reaches the model", () => {
  it("is only non-empty text", async () => {
    const { engine, voice, client } = call([say(GREETING), say("One."), say("Two.")], ["", new VoiceError("x"), "Heard this"]);

    await runTalk(engine, voice, terminal(["", "", "", "Typed this", ""]).io);

    const utterances = client.requests.slice(1).map((r) => r.messages.at(-1));
    expect(JSON.stringify(utterances)).toContain("Typed this");
    expect(JSON.stringify(utterances)).toContain("Heard this");
    expect(client.requests).toHaveLength(3);
  });
});

describe("the Voice seam", () => {
  it("does not import from the engine", async () => {
    const source = await readFile("src/voice/voice.ts", "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*engine/);
  });
});

describe("a refused Turn", () => {
  it("speaks only the safe line, never the text that streamed before the refusal", async () => {
    const { engine, voice } = call([say(GREETING), reply([{ type: "text", text: "Sure, here is how to do it" }], "refusal")]);

    await runTalk(engine, voice, terminal(["Something awful"]).io);

    expect(voice.spoken).toEqual([GREETING, REFUSAL_LINE]);
  });
});

describe("saying goodbye", () => {
  it("speaks the End state's message exactly once, ends the Call and does not ask again", async () => {
    const { engine, voice } = call([say(GREETING), goodbye()]);
    const { io, output } = terminal(["No thanks, goodbye."]);

    const result = await runTalk(engine, voice, io);

    expect(voice.spoken).toEqual([GREETING, GOODBYE_MESSAGE]);
    expect(output().endsWith(`Receptionist: ${GOODBYE_MESSAGE}\n`)).toBe(true);
    expect(result).toBe("ended");
  });

  it("speaks what was already said and the End state's message as one reply", async () => {
    const { engine, voice } = call([say(GREETING), goodbye("Happy to help.")]);

    await runTalk(engine, voice, terminal(["Bye"]).io);

    expect(voice.spoken).toEqual([GREETING, `Happy to help. ${GOODBYE_MESSAGE}`]);
  });
});
