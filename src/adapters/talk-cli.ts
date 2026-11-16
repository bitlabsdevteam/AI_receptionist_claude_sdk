import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ConfigError, loadDotEnv, requireTalkConfig } from "../config.js";
import { AnthropicModelClient } from "../engine/anthropic-client.js";
import { FlowEngine } from "../engine/engine.js";
import { loadFlow } from "../flow/load.js";
import { ElevenLabsVoice } from "../voice/elevenlabs.js";
import { recordClip } from "../voice/recorder.js";
import { VoiceInterrupted } from "../voice/voice.js";
import type { ChatIO } from "./chat.js";
import { LineQueue } from "./line-queue.js";
import { runTalk } from "./talk.js";

/** Used when FLOW_PATH is not set. Relative to the project, not to where the program was started from. */
const DEFAULT_FLOW_PATH = fileURLToPath(new URL("../../flows/receptionist.json", import.meta.url));

/**
 * Shown while the recorder runs. The recorder is started just before this is printed, and nothing knows the moment
 * the microphone opens, so words said at once may be missed.
 */
const RECORDING_PROMPT = "(Recording. Press Enter to stop.) ";

async function main(): Promise<number> {
  try {
    loadDotEnv();
    requireTalkConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  const flow = await loadFlow(process.env.FLOW_PATH ? resolve(process.env.FLOW_PATH) : DEFAULT_FLOW_PATH);
  const engine = new FlowEngine(flow, { client: new AnthropicModelClient() });

  const { stdin, stdout } = process;
  const rl = createInterface({ input: stdin, output: stdout });
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
    if (stdin.isTTY && !inputClosed) {
      rl.setPrompt(prompt);
      rl.prompt();
    } else {
      stdout.write(prompt);
    }
    const line = await lines.next(signal);
    // A pipe is not echoed back by the terminal, so show the line to keep the transcript readable.
    if (line !== undefined && !stdin.isTTY) stdout.write(`${line}\n`);
    return line;
  }

  /** Set while a recording waits for Enter. Ctrl-C then ends the recording, and with it the Call, in good order. */
  let interruptRecording: (() => void) | undefined;
  rl.on("SIGINT", () => {
    if (interruptRecording) return interruptRecording();
    // Otherwise Ctrl-C quits at once, even while a reply is streaming.
    stdout.write("\n");
    process.exit(0);
  });

  /** The Enter that stops a recording. Whatever is typed before it is not the Caller's words and is dropped. */
  function waitForEnter(signal: AbortSignal): Promise<void> {
    const stopped = readLine(RECORDING_PROMPT, signal).then((line) => {
      if (line !== undefined) return;
      stdout.write("\n");
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

  const voice = ElevenLabsVoice.fromEnv(process.env, { recorder: () => recordClip({ waitForEnter }) });
  const io: ChatIO = {
    write: (text) => void stdout.write(text),
    ask: (prompt) => readLine(prompt),
    get columns() {
      return stdout.isTTY ? stdout.columns : undefined;
    },
  };

  const talkResult = await runTalk(engine, voice, io, {
    label: flow.variables.receptionist_name ?? "Receptionist",
    clock: () => performance.now(),
  });
  if (talkResult === "input-closed") stdout.write("\n");
  rl.close();
  return talkResult === "failed" ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
