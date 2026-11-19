import type { FlowEngine } from "../engine/engine.js";
import { messageOf } from "./message-of.js";
import { TerminalReply } from "./terminal-reply.js";

/** The Caller's side of a terminal: where the Receptionist's words go and where the Caller's come from. */
export interface ChatIO {
  write(text: string): void;
  /** Shows `prompt` and returns the line the Caller types, or `undefined` once the input has closed (Ctrl-D, end of a pipe). */
  ask(prompt: string): Promise<string | undefined>;
  /** Width of the terminal. Present only for a real terminal, which is what lets withdrawn text be erased. */
  columns?: number;
}

export interface ChatOptions {
  /** Shown before the Receptionist's words. */
  label?: string;
  callId?: string;
}

/**
 * How the Call ended:
 * - `ended`: the Receptionist reached an End state, such as the Caller saying goodbye.
 * - `input-closed`: the Caller's input ran out.
 * - `failed`: the Call could not be opened.
 */
export type ChatResult = "ended" | "input-closed" | "failed";

/** Runs one Call in a terminal: the Receptionist greets first, then the Caller types and replies stream back. */
export async function runChat(engine: FlowEngine, io: ChatIO, options: ChatOptions = {}): Promise<ChatResult> {
  const { label = "Receptionist", callId = "terminal" } = options;
  const reply = new TerminalReply(io.write, `${label}: `, io.columns);

  try {
    await engine.start(callId, {}, reply);
  } catch (error) {
    io.write(`Could not open the Call: ${messageOf(error)}\n`);
    return "failed";
  }
  reply.end();

  for (let turn = 1; ; turn++) {
    const line = (await io.ask("You: "))?.trim();
    if (line === undefined) return "input-closed";
    if (line === "") {
      turn--;
      continue;
    }
    try {
      const result = await engine.handleUser(callId, line, `turn-${turn}`, reply);
      reply.end();
      if (result.ended) return "ended";
    } catch (error) {
      // The engine has already withdrawn any partial reply, and a failed Turn is not recorded, so the Caller can retry.
      reply.end();
      io.write(`(The Receptionist could not answer: ${messageOf(error)}. Please try again.)\n`);
      turn--;
    }
  }
}
