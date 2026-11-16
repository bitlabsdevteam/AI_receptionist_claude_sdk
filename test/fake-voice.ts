import type { Voice } from "../src/voice/voice.js";

/** What a scripted `listen()` gives: a transcript, or an error to throw. */
export type Heard = string | Error;

/**
 * Scripted stand-in for a Voice. `listen()` returns the scripted transcripts and failures in order, and throws once
 * the script runs out (so a test that listens more than it meant to fails loudly). Everything handed to `speak()` is
 * recorded in `spoken`. `speakFailures` makes the first calls to `speak()` throw, one error each, instead of speaking.
 */
export class FakeVoice implements Voice {
  readonly spoken: string[] = [];
  /** How many times `listen()` was called. */
  listens = 0;
  readonly #heard: Heard[];
  readonly #speakFailures: Error[];

  constructor(heard: readonly Heard[] = [], speakFailures: readonly Error[] = []) {
    this.#heard = [...heard];
    this.#speakFailures = [...speakFailures];
  }

  async speak(text: string): Promise<void> {
    const failure = this.#speakFailures.shift();
    if (failure) throw failure;
    this.spoken.push(text);
  }

  async listen(): Promise<string> {
    this.listens++;
    const next = this.#heard.shift();
    if (next === undefined) throw new Error("FakeVoice has nothing left to hear");
    if (next instanceof Error) throw next;
    return next;
  }
}
