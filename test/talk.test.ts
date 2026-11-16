import { beforeAll, describe, expect, it } from "vitest";
import type { ChatIO } from "../src/adapters/chat.js";
import { runTalk } from "../src/adapters/talk.js";
import { FlowEngine } from "../src/engine/engine.js";
import type { ModelResponse } from "../src/engine/model.js";
import { loadFlow } from "../src/flow/load.js";
import type { Flow } from "../src/flow/schema.js";
import { FakeClaude, GREETING, say, type ScriptedFailure } from "./fake-claude.js";
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
