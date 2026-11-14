import { beforeAll, describe, expect, it } from "vitest";
import { runChat, type ChatIO } from "../src/adapters/chat.js";
import { FlowEngine, REFUSAL_LINE } from "../src/engine/engine.js";
import type { ContentBlock, ModelResponse } from "../src/engine/model.js";
import { loadFlow } from "../src/flow/load.js";
import type { Flow } from "../src/flow/schema.js";
import { FakeClaude, failAfter, reply, say, type ScriptedFailure } from "./fake-claude.js";

const GREETING = "Hello, this is Ava from Acme Co. How can I help you today?";
const GOODBYE_MESSAGE = "Thank you for calling. Goodbye.";

let flow: Flow;
beforeAll(async () => {
  flow = await loadFlow("flows/receptionist.json");
});

function goodbye(text?: string): ModelResponse {
  const content: ContentBlock[] = [
    ...(text ? [{ type: "text" as const, text }] : []),
    { type: "tool_use", id: "t1", name: "transition__e_start_goodbye", input: { reason: "done" } },
  ];
  return reply(content, "tool_use");
}

/** What a terminal of `columns` width shows after `writes`. Understands newline, carriage return, cursor up and clear-below. */
function screenOf(writes: readonly string[], columns: number): string {
  const rows: string[][] = [[]];
  let row = 0;
  let col = 0;
  const text = writes.join("");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\x1b") {
      const match = /^\x1b\[(\d*)([AJ])/.exec(text.slice(i));
      if (!match) throw new Error("unsupported escape sequence in output");
      if (match[2] === "A") row = Math.max(0, row - Number(match[1] || 1));
      else {
        rows[row] = (rows[row] ?? []).slice(0, col);
        rows.length = row + 1;
      }
      i += match[0].length - 1;
    } else if (ch === "\r") col = 0;
    else if (ch === "\n") {
      row++;
      col = 0;
      rows[row] ??= [];
    } else {
      if (col >= columns) {
        row++;
        col = 0;
        rows[row] ??= [];
      }
      (rows[row] ??= [])[col++] = ch;
    }
  }
  return rows.map((r) => r.join("")).join("\n");
}

/** A Caller who types `lines` and then closes the input. */
function session(lines: string[], columns?: number) {
  const writes: string[] = [];
  const asked: string[] = [];
  const queue = [...lines];
  const io: ChatIO = {
    write: (text) => void writes.push(text),
    async ask(prompt) {
      writes.push(prompt);
      asked.push(prompt);
      const line = queue.shift();
      if (line !== undefined) writes.push(`${line}\n`);
      return line;
    },
    ...(columns !== undefined ? { columns } : {}),
  };
  return { io, writes, asked, output: () => writes.join("") };
}

function chat(script: (ModelResponse | ScriptedFailure)[]) {
  const client = new FakeClaude(script);
  const engine = new FlowEngine(flow, { client });
  return { client, engine };
}

describe("opening the chat", () => {
  it("shows the Receptionist's greeting before asking the Caller for anything", async () => {
    const { engine } = chat([say(GREETING)]);
    const { io, output } = session([]);

    await runChat(engine, io);

    expect(output().startsWith(`Receptionist: ${GREETING}\n`)).toBe(true);
    expect(output().indexOf("You: ")).toBeGreaterThan(output().indexOf(GREETING));
  });

  it("streams the greeting piece by piece rather than all at once", async () => {
    const { engine } = chat([say(GREETING)]);
    const { io, writes } = session([]);

    await runChat(engine, io);

    const greetingWrites = writes.filter((w) => w !== "You: " && GREETING.includes(w.trim()) && w.trim() !== "");
    expect(greetingWrites.length).toBeGreaterThan(5);
    expect(greetingWrites.every((w) => w.length < GREETING.length)).toBe(true);
  });

  it("opens the Call with no Caller number", async () => {
    const { engine, client } = chat([say(GREETING)]);

    await runChat(engine, session([]).io);

    expect(client.requests).toHaveLength(1);
  });
});

describe("talking", () => {
  it("shows each reply under the Caller's line and then asks again", async () => {
    const { engine } = chat([say(GREETING), say("We are Acme Co."), say("Happy to help.")]);
    const { io, output, asked } = session(["Who are you?", "Thanks."]);

    const outcome = await runChat(engine, io);

    expect(output()).toBe(
      `Receptionist: ${GREETING}\nYou: Who are you?\nReceptionist: We are Acme Co.\nYou: Thanks.\nReceptionist: Happy to help.\nYou: `,
    );
    expect(asked).toHaveLength(3);
    expect(outcome).toBe("input-closed");
  });

  it("skips blank lines without calling the model", async () => {
    const { engine, client } = chat([say(GREETING), say("Hi.")]);

    await runChat(engine, session(["", "   ", "Hello"]).io);

    expect(client.requests).toHaveLength(2);
  });

  it("stops quietly when the input closes", async () => {
    const { engine } = chat([say(GREETING)]);

    await expect(runChat(engine, session([]).io)).resolves.toBe("input-closed");
  });
});

describe("saying goodbye", () => {
  it("shows the closing message once, ends the Call and does not ask again", async () => {
    const { engine } = chat([say(GREETING), goodbye()]);
    const { io, output, asked } = session(["No thanks, goodbye."]);

    const outcome = await runChat(engine, io);

    expect(outcome).toBe("ended");
    expect(output()).toBe(`Receptionist: ${GREETING}\nYou: No thanks, goodbye.\nReceptionist: ${GOODBYE_MESSAGE}\n`);
    expect(asked).toHaveLength(1);
  });

  it("shows what the model said before the closing message, with the closing message only once", async () => {
    const { engine } = chat([say(GREETING), goodbye("Glad I could help.")]);
    const { io, output } = session(["That is all."]);

    await runChat(engine, io);

    const shown = output();
    expect(shown).toContain(`Receptionist: Glad I could help. ${GOODBYE_MESSAGE}\n`);
    expect(shown.split(GOODBYE_MESSAGE)).toHaveLength(2);
  });
});

describe("a reply that is thrown away", () => {
  it("leaves only the safe line on a terminal after a refusal that streamed some text", async () => {
    const { engine } = chat([say(GREETING), reply([{ type: "text", text: "Sure, here is how to do it" }], "refusal")]);
    const { writes, io } = session(["Do something bad"], 200);

    await runChat(engine, io);

    expect(screenOf(writes, 200)).toBe(
      `Receptionist: ${GREETING}\nYou: Do something bad\nReceptionist: ${REFUSAL_LINE}\nYou: `,
    );
  });

  it("erases correctly when the withdrawn text had wrapped onto several rows", async () => {
    const long = "Sure, here is a very long answer that wraps over many rows of a narrow terminal window";
    const { engine } = chat([say("Hi."), reply([{ type: "text", text: long }], "refusal")]);
    const { writes, io } = session(["Do something bad"], 20);

    await runChat(engine, io);

    const screen = screenOf(writes, 20);
    expect(screen).not.toContain("Sure");
    // Rows are cut at the window width, so look at the text with the row breaks taken out.
    expect(screen.replaceAll("\n", "")).toContain("I'm sorry, I can't help with that.");
    expect(screen.match(/Receptionist:/g)).toHaveLength(2);
  });

  it("marks the withdrawn text when output is not a terminal, since it cannot be erased", async () => {
    const { engine } = chat([say(GREETING), reply([{ type: "text", text: "Sure, here is how" }], "refusal")]);
    const { io, output } = session(["Do something bad"]);

    await runChat(engine, io);

    expect(output()).toContain(`Receptionist: Sure, here is how [withdrawn]\nReceptionist: ${REFUSAL_LINE}\n`);
  });

  it("shows the error, shows no half-sentence, and lets the Caller try again after a failed request", async () => {
    const { engine } = chat([say(GREETING), failAfter("Let me che", new Error("connection reset")), say("I'm back.")]);
    const { writes, io } = session(["Hello?", "Hello again?"], 80);

    const outcome = await runChat(engine, io);

    const screen = screenOf(writes, 80);
    expect(screen).not.toContain("Let me che");
    expect(screen).toContain("connection reset");
    expect(screen).toContain("Receptionist: I'm back.");
    expect(outcome).toBe("input-closed");
  });

  it("gives up when the greeting cannot be fetched", async () => {
    const { engine } = chat([failAfter("", new Error("401 invalid x-api-key"))]);
    const { io, output, asked } = session(["hello"]);

    const outcome = await runChat(engine, io);

    expect(outcome).toBe("failed");
    expect(output()).toContain("401 invalid x-api-key");
    expect(asked).toHaveLength(0);
  });
});
