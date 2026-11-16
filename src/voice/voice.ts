/**
 * The Receptionist's Voice: speech out and speech in. An adapter hands the Voice the words to say and asks it what the
 * Caller said. It knows nothing about the engine, so nothing in `src/voice/` imports from `src/engine/`.
 */
export interface Voice {
  /** Says `text` aloud and resolves once it has been said. Throws `VoiceError` if it could not be. */
  speak(text: string): Promise<void>;
  /**
   * Waits for the Caller to speak and returns what they said. Empty when nothing was heard. Throws `VoiceError` on
   * failure. `onRecorded` is called once the Caller's speech is in hand and transcription begins, which lets an
   * adapter time the two apart.
   */
  listen(onRecorded?: () => void): Promise<string>;
}

/** A Voice failed to speak or listen. Lets an adapter tell this apart from a failure in the Call itself. */
export class VoiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VoiceError";
  }
}

/** The Caller interrupted while the Voice was listening (Ctrl-C). The adapter ends the Call rather than retrying. */
export class VoiceInterrupted extends VoiceError {
  constructor(message = "The Caller interrupted.") {
    super(message);
    this.name = "VoiceInterrupted";
  }
}
