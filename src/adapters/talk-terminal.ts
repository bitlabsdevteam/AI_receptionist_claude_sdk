import { createInterface } from "node:readline";
import { VoiceInterrupted } from "../voice/voice.js";
import type { ChatIO } from "./chat.js";
import { LineQueue } from "./line-queue.js";

/**
 * Shown while the recorder runs. The recorder is started just before this is printed, and nothing knows the moment
 * the microphone opens, so words said at once may be missed.
 */
export const RECORDING_PROMPT = "(Recording. Press Enter to stop.) ";

/** The Caller's side of a spoken Call in a terminal: the typed lines, the Enter that stops a recording, and Ctrl-C. */
export interface TalkTerminal {
  /** Where `runTalk` writes, and where it reads the Caller's typed lines. */
  io: ChatIO;
  /**
   * The Enter that stops a recording, as `recordClip` wants it. Whatever is typed before it is not the Caller's words
   * and is dropped. Rejects with `VoiceInterrupted` on Ctrl-C or when the input closes. When `signal` aborts (the
   * recorder died first) the wait ends quietly and takes no line.
   */
  waitForEnter(signal: AbortSignal): Promise<void>;
  /** Lets go of the input. */
  close(): void;
}

type Input = NodeJS.ReadableStream & { isTTY?: boolean };
type Output = NodeJS.WritableStream & { isTTY?: boolean; columns?: number };

/**
 * Opens the Caller's side of a spoken Call on `input` and `output`, which are the process's own in `npm run talk`.
 * Ctrl-C during a recording ends the recording, and with it the Call, in good order. At any other moment it writes a
 * new line and calls `quit`, even while a reply is streaming.
 */
export function openTalkTerminal(input: Input, output: Output, quit: () => void): TalkTerminal {
  const rl = createInterface({ input, output });
  // Lines go through a queue, not a pending read on readline, because the wait for the Enter that stops a recording
  // must be called off when the recorder dies first. A pending read would swallow the Caller's next line.
  const lines = new LineQueue();
  let inputClosed = false;
  rl.on("line", (line) => lines.push(line));
  rl.on("close", () => {
    inputClosed = true;
    lines.close();
  });

  /** Shows `prompt` and returns the Caller's next line: `undefined` once the input has closed or `signal` aborts. */
  async function readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    // readline owns the prompt on a terminal so that line editing redraws it. Piped input can end, and so close
    // readline, before the Receptionist has finished speaking, so there the prompt is just written.
    if (input.isTTY && !inputClosed) {
      rl.setPrompt(prompt);
      rl.prompt();
    } else {
      output.write(prompt);
    }
    const line = await lines.next(signal);
    // A pipe is not echoed back by the terminal, so show the line to keep the transcript readable.
    if (line !== undefined && !input.isTTY) output.write(`${line}\n`);
    return line;
  }

  /** Set while a recording waits for Enter. */
  let interruptRecording: (() => void) | undefined;
  rl.on("SIGINT", () => {
    if (interruptRecording) return interruptRecording();
    output.write("\n");
    quit();
  });

  function waitForEnter(signal: AbortSignal): Promise<void> {
    const stopped = readLine(RECORDING_PROMPT, signal).then((line) => {
      if (line !== undefined) return;
      output.write("\n");
      // Aborted means the recorder died first, and its own error is the one to report.
      if (!signal.aborted) throw new VoiceInterrupted("The input closed while recording.");
    });
    const interrupted = new Promise<never>((_, reject) => {
      interruptRecording = () => reject(new VoiceInterrupted());
    });
    return Promise.race([stopped, interrupted]).finally(() => {
      interruptRecording = undefined;
    });
  }

  return {
    io: {
      write: (text) => void output.write(text),
      ask: (prompt) => readLine(prompt),
      get columns() {
        return output.isTTY ? output.columns : undefined;
      },
    },
    waitForEnter,
    close: () => rl.close(),
  };
}
