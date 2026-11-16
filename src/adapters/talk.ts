import type { FlowEngine } from "../engine/engine.js";
import { VoiceInterrupted, type Voice } from "../voice/voice.js";
import type { ChatIO } from "./chat.js";
import { TerminalReply } from "./terminal-reply.js";

export interface TalkOptions {
  /** Shown before the Receptionist's words. */
  label?: string;
  callId?: string;
  /**
   * Reads the time in ms. When given, a timing line follows each Turn, saying how long each step took. It is plain
   * output for whoever is at the terminal, not a Trace.
   */
  clock?: () => number;
}

/**
 * How the Call ended:
 * - `ended`: the Receptionist reached an End state, such as the Caller saying goodbye.
 * - `input-closed`: the Caller's input ran out.
 * - `interrupted`: the Caller interrupted while the Voice was listening.
 * - `failed`: the Call could not be opened.
 */
export type TalkResult = "ended" | "input-closed" | "interrupted" | "failed";

/**
 * Runs one spoken Call in a terminal. Like `runChat`, the Receptionist's text is always printed, streaming in. On top
 * of that the Voice speaks the Turn's final `reply`, once, after the Turn has finished: never while text streams,
 * because a stream may still be discarded (I6) and speech cannot be unspoken.
 */
export async function runTalk(engine: FlowEngine, voice: Voice, io: ChatIO, options: TalkOptions = {}): Promise<TalkResult> {
  const { label = "Receptionist", callId = "terminal", clock } = options;
  const now = clock ?? (() => 0);
  const reply = new TerminalReply(io.write, `${label}: `, io.columns);

  /** Says the Turn's final reply. A failure costs one line of text and nothing else: the Turn and the Call are untouched. */
  async function speak(text: string): Promise<void> {
    try {
      await voice.speak(text);
    } catch (error) {
      io.write(`(Could not speak: ${messageOf(error)})\n`);
    }
  }

  try {
    const greeting = await engine.start(callId, {}, reply);
    reply.end();
    await speak(greeting.reply);
  } catch (error) {
    io.write(`Could not open the Call: ${messageOf(error)}\n`);
    return "failed";
  }

  for (let turn = 1; ; turn++) {
    const typed = (await io.ask("You (Enter to speak, or type): "))?.trim();
    if (typed === undefined) return "input-closed";
    let line = typed;
    const steps: Step[] = [];
    if (typed === "") {
      try {
        const started = now();
        let recorded: number | undefined;
        line = (await voice.listen(() => void (recorded = now()))).trim();
        const heard = now();
        // `record` is the Caller speaking plus the recorder starting and stopping. A Voice that does not say when the
        // recording was in hand gets one figure for the two steps, not a made-up split.
        if (recorded === undefined) steps.push(["listen", heard - started]);
        else steps.push(["record", recorded - started], ["transcribe", heard - recorded]);
      } catch (error) {
        if (error instanceof VoiceInterrupted) return "interrupted";
        io.write(`(Could not hear you: ${reasonOf(error)}. Please try again.)\n`);
        turn--;
        continue;
      }
      if (line === "") {
        // Answered here, not by the Receptionist: nothing reaches the model and no turn id is spent.
        io.write("I didn't catch that. Please try again.\n");
        turn--;
        continue;
      }
      io.write(`You: ${line}\n`);
    }
    try {
      const asked = now();
      const result = await engine.handleUser(callId, line, `turn-${turn}`, reply);
      reply.end();
      const answered = now();
      await speak(result.reply);
      steps.push(["model", answered - asked], ["speak", now() - answered]);
      if (clock) io.write(`${timingLine(steps)}\n`);
      if (result.ended) return "ended";
    } catch (error) {
      reply.end();
      io.write(`(The Receptionist could not answer: ${reasonOf(error)}. Please try again.)\n`);
      turn--;
    }
  }
}

/** One step of a Turn and how long it took, in ms. */
type Step = [name: string, ms: number];

/**
 * How long each step of a Turn took, such as `(Timing: record 1200 ms, transcribe 300 ms, model 450 ms, speak 700 ms)`.
 * `model` is the whole Turn in the engine, every hop included. `speak` runs until the reply has been said, so it
 * grows with the length of the reply. A typed Turn has no `record` or `transcribe`.
 */
function timingLine(steps: Step[]): string {
  return `(Timing: ${steps.map(([name, ms]) => `${name} ${Math.round(ms)} ms`).join(", ")})`;
}

/** The error's message without a closing full stop, to go in the middle of a sentence. */
function reasonOf(error: unknown): string {
  return messageOf(error).replace(/\.$/, "");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
