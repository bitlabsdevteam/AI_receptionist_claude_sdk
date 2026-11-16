/**
 * The Relay connection's frames, as Telnyx's Conversation Relay guide gives them, and the spike's fixed replies. No
 * model is involved: the greeting, an echo of what Telnyx heard, and a long reply on request.
 */

/** Opens on a word that is easy to hear clipped (experiment 3). */
export const GREETING = "Hello, this is the Relay test line. Say something, and I will repeat what I heard.";

/** About 600 characters, in numbered sentences, so the Caller can tell where speech stopped (experiments 4 and 6). */
export const LONG_REPLY =
  "This is the long reply, in ten numbered sentences. " +
  "Sentence one: the quick brown fox jumps over the lazy dog. " +
  "Sentence two: a journey of a thousand miles begins with a single step. " +
  "Sentence three: the rain in Spain stays mainly in the plain. " +
  "Sentence four: every good boy deserves fruit. " +
  "Sentence five: the early bird catches the worm. " +
  "Sentence six: a stitch in time saves nine. " +
  "Sentence seven: actions speak louder than words. " +
  "Sentence eight: practice makes perfect. " +
  "Sentence nine: better late than never, as people say. " +
  "Sentence ten is the last one, and the last word of this long reply is pineapple.";

/** Sent straight after the long reply by the `q` key, to hear what happens to speech still queued (experiment 6). */
export const QUEUED_REPLY = "This is the second, queued reply. Its last word is umbrella.";

/** Spoken with Call Control `speak` by the closing sequence, after the Relay has been stopped (experiment 8). */
export const CLOSING_LINE = "This is the closing line, spoken after the Relay stopped. Its last word is goodbye.";

/** Spoken with Call Control `speak` by the `k` key (experiments 10 and 12). */
export const SPEAK_LINE = "This line is spoken with the speak command. Its last word is lantern.";

/** The types in the guide's "Frames sent by Telnyx" table, plus `info`, which only the TeXML verb page documents. */
const KNOWN_TYPES = new Set(["setup", "prompt", "eagerEndOfTurn", "turnResumed", "dtmf", "interrupt", "error", "info"]);

export type InboundFrame =
  | { type: string; known: boolean; body: Record<string, unknown> }
  | { type: "unreadable"; known: false; raw: string };

export type TextFrame = { type: "text"; token: string; last: true };

/** Reads one text frame from Telnyx. Never throws: anything that is not a JSON object with a `type` is `unreadable`. */
export function readFrame(raw: string): InboundFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "unreadable", known: false, raw };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { type: "unreadable", known: false, raw };
  const body = parsed as Record<string, unknown>;
  if (typeof body.type !== "string") return { type: "unreadable", known: false, raw };
  return { type: body.type, known: KNOWN_TYPES.has(body.type), body };
}

/** A whole reply in one frame. `last: true` tells Telnyx the reply is complete. */
export function textFrame(token: string): TextFrame {
  return { type: "text", token, last: true };
}

/** The final transcript of a `prompt` frame, or undefined for a partial one, an empty one and every other frame. */
export function finalPrompt(frame: InboundFrame): string | undefined {
  if (frame.type !== "prompt" || !("body" in frame) || frame.body.last !== true) return undefined;
  const heard = frame.body.voicePrompt;
  return typeof heard === "string" && heard.trim() !== "" ? heard : undefined;
}

/** What the spike says back: the greeting after `setup`, an echo after a final prompt, and nothing otherwise. */
export function repliesTo(frame: InboundFrame): TextFrame[] {
  if (frame.type === "setup") return [textFrame(GREETING)];
  const heard = finalPrompt(frame);
  return heard === undefined ? [] : [textFrame(`You said: ${heard}`)];
}
