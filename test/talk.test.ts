import { beforeAll, describe, expect, it } from "vitest";
import type { ChatIO } from "../src/adapters/chat.js";
import { runTalk } from "../src/adapters/talk.js";
import { FlowEngine, REFUSAL_LINE } from "../src/engine/engine.js";
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
  const engine = new FlowEngine(flow, { client });
  const voice = new FakeVoice(heard, speakFailures);
  return { client, engine, voice };
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
