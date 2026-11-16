import type { FlowEngine } from "../engine/engine.js";
import type { Voice } from "../voice/voice.js";
import type { ChatIO } from "./chat.js";
import { TerminalReply } from "./terminal-reply.js";

export interface TalkOptions {
  /** Shown before the Receptionist's words. */
  label?: string;
  callId?: string;
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
  const { label = "Receptionist", callId = "terminal" } = options;
  const reply = new TerminalReply(io.write, `${label}: `, io.columns);

  try {
    const greeting = await engine.start(callId, {}, reply);
    reply.end();
    await voice.speak(greeting.reply);
  } catch (error) {
    io.write(`Could not open the Call: ${messageOf(error)}\n`);
    return "failed";
  }

  for (let turn = 1; ; turn++) {
    const typed = (await io.ask("You (Enter to speak, or type): "))?.trim();
    if (typed === undefined) return "input-closed";
    let line = typed;
    if (typed === "") {
      line = (await voice.listen()).trim();
      io.write(`You: ${line}\n`);
    }
    try {
      const result = await engine.handleUser(callId, line, `turn-${turn}`, reply);
      reply.end();
      await voice.speak(result.reply);
      if (result.ended) return "ended";
    } catch (error) {
      reply.end();
      io.write(`(The Receptionist could not answer: ${messageOf(error)}. Please try again.)\n`);
      turn--;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
