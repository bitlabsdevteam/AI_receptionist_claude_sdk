import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECORDING_PROMPT, openTalkTerminal, type TalkTerminal } from "../src/adapters/talk-terminal.js";
import { VoiceInterrupted } from "../src/voice/voice.js";

/**
 * The Caller's side of a spoken Call, driven through in-memory streams: no child process and no real terminal. With
 * `tty`, readline treats the streams as a terminal and reads keys, which is the only way it ever reports Ctrl-C.
 */

const CTRL_C = "\x03";
const ENTER = "\r";

let opened: TalkTerminal | undefined;
afterEach(() => {
  opened?.close();
  opened = undefined;
});

function open(tty: boolean) {
  const input = Object.assign(new PassThrough(), tty ? { isTTY: true } : {});
  const output = Object.assign(new PassThrough(), tty ? { isTTY: true, columns: 80 } : {});
  let shown = "";
  output.on("data", (chunk: Buffer) => (shown += chunk.toString()));
  const quit = vi.fn();
  opened = openTalkTerminal(input, output, quit);
  return { terminal: opened, input, quit, shown: () => shown };
}

/** The outcome of a wait, without leaving a rejection unhandled while the test goes on. */
function settled(wait: Promise<void>): Promise<unknown> {
  return wait.then(
    () => "stopped",
    (error: unknown) => error,
  );
}

/** Long enough for readline to have read whatever was just typed. */
const keysRead = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("Ctrl-C at the terminal", () => {
  it("ends a recording that waits for Enter with VoiceInterrupted, and does not quit", async () => {
    const { terminal, input, quit } = open(true);
    const wait = settled(terminal.waitForEnter(new AbortController().signal));

    input.write(CTRL_C);

    expect(await wait).toBeInstanceOf(VoiceInterrupted);
    expect(quit).not.toHaveBeenCalled();
  });

  it("quits at once outside a recording, on a new line", async () => {
    const { input, quit, shown } = open(true);

    input.write(CTRL_C);

    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(shown().endsWith("\n")).toBe(true);
  });

  it("quits while the Caller is at the prompt", async () => {
    const { terminal, input, quit } = open(true);
    void terminal.io.ask("You (Enter to speak, or type): ");

    input.write(CTRL_C);

    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
  });

  it("quits once the recording has been stopped with Enter", async () => {
    const { terminal, input, quit } = open(true);
    const wait = settled(terminal.waitForEnter(new AbortController().signal));
    input.write(ENTER);
    expect(await wait).toBe("stopped");

    input.write(CTRL_C);

    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
  });

  it("quits once the wait for Enter was called off because the recorder died", async () => {
    const { terminal, input, quit } = open(true);
    const recorderDied = new AbortController();
    const wait = settled(terminal.waitForEnter(recorderDied.signal));
    recorderDied.abort();
    expect(await wait).toBe("stopped");

    input.write(CTRL_C);

    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
  });
});

describe("the Enter that stops a recording", () => {
  it("is waited for under the recording prompt, and whatever was typed before it is dropped", async () => {
    const { terminal, input, shown } = open(true);
    const wait = settled(terminal.waitForEnter(new AbortController().signal));
    await keysRead();
    expect(await Promise.race([wait, "still waiting"])).toBe("still waiting");

    input.write(`not the Caller's words${ENTER}`);

    expect(await wait).toBe("stopped");
    expect(shown()).toContain(RECORDING_PROMPT);
    input.write(`next line${ENTER}`);
    expect(await terminal.io.ask("You: ")).toBe("next line");
  });

  it("raises VoiceInterrupted when the input closes instead", async () => {
    const { terminal, input, quit } = open(false);
    const wait = settled(terminal.waitForEnter(new AbortController().signal));

    input.end();

    const error = await wait;
    expect(error).toBeInstanceOf(VoiceInterrupted);
    expect((error as Error).message).toBe("The input closed while recording.");
    expect(quit).not.toHaveBeenCalled();
  });

  it("is called off without an error, and without taking the Caller's next line, when the recorder died first", async () => {
    const { terminal, input } = open(false);
    const recorderDied = new AbortController();
    const wait = settled(terminal.waitForEnter(recorderDied.signal));

    recorderDied.abort();
    input.write("bye for now\n");

    expect(await wait).toBe("stopped");
    expect(await terminal.io.ask("You: ")).toBe("bye for now");
  });
});

describe("a typed line", () => {
  it("is asked for with the prompt and echoed when the input is a pipe, which the terminal does not echo", async () => {
    const { terminal, input, shown } = open(false);
    input.write("hello\n");

    expect(await terminal.io.ask("You: ")).toBe("hello");
    expect(shown()).toBe("You: hello\n");
  });

  it("is undefined once the input has closed, and lines typed before that are still handed out", async () => {
    const { terminal, input } = open(false);
    input.end("last words\n");

    expect(await terminal.io.ask("You: ")).toBe("last words");
    expect(await terminal.io.ask("You: ")).toBeUndefined();
  });

  it("gives the terminal's width only for a real terminal", () => {
    expect(open(true).terminal.io.columns).toBe(80);
    opened?.close();
    expect(open(false).terminal.io.columns).toBeUndefined();
  });
});
