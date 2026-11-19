import { directionOf, jsonObject, text, type CallDirection, type JsonObject } from "./fields.js";

/**
 * The frames of the Relay connection: the WebSocket that Telnyx Conversation Relay opens to our server, one per call.
 * Every frame is a JSON text message with a `type`. Telnyx turns the Caller's speech into text and our text into
 * speech, so only text crosses it. `parseRelayFrame` reads what Telnyx sends and `textFrame` builds what we send.
 *
 * Telnyx's guide documents the frames by example only. It does not say in what order `interrupt` and `prompt` arrive,
 * or what happens to speech still queued when the Caller speaks over a reply: unconfirmed until the spike (#23).
 */

/** `setup`: the first frame after the connection opens. It names the call the connection is for. */
export interface RelaySetup {
  kind: "setup";
  /** Telnyx's id of the call leg, the same one webhooks carry as `call_control_id`. */
  callControlId: string;
  /** Telnyx's id of the whole call, the same one webhooks carry as `call_session_id`. */
  callSessionId: string;
  /** Telnyx's id of this Relay connection (its `sessionId`). */
  relayConnectionId: string | undefined;
  /** The guide's example says `inbound` where a webhook says `incoming`. Both are read as `inbound`. */
  direction: CallDirection | undefined;
  from: string | undefined;
  to: string | undefined;
}

/** A `prompt` with `last: true`: what the Caller said, once they have finished saying it. */
export interface RelayUtterance {
  kind: "utterance";
  /** Trimmed. It can be empty, and whether an empty one counts is for the Call's rules, not for this parser. */
  text: string;
  /** Telnyx's `lang`, such as `en`. */
  language: string | undefined;
}

/**
 * A `prompt` that is not final: the Caller's words so far, while they are still speaking. It is not an utterance, and
 * it has a kind of its own so that it cannot be taken for one. Only `last: true` makes a prompt final: Telnyx documents
 * partial prompts as `last: false` and shows none without `last`.
 */
export interface RelayPartialPrompt {
  kind: "partialPrompt";
  text: string;
}

/**
 * `interrupt`: the Caller spoke over a reply. The two fields appear in the guide's one example and are described
 * nowhere, so whether `spokenBefore` is exact to the word is unconfirmed until the spike (#23).
 */
export interface RelayInterrupt {
  kind: "interrupt";
  /** Telnyx's `utteranceUntilInterrupt`: the part of the reply said before the Caller cut in. */
  spokenBefore: string | undefined;
  /** Telnyx's `durationUntilInterruptMs`. */
  afterMs: number | undefined;
}

/** `dtmf`: a keypad press. The phone Channel does not ask for these and ignores them. */
export interface RelayKeypad {
  kind: "keypad";
  digit: string | undefined;
}

/** `error`: Telnyx could not use a frame we sent. After several it may close the connection. */
export interface RelayError {
  kind: "error";
  /** Telnyx's words, or empty when it gave none. */
  description: string;
}

/**
 * A frame type nothing here acts on. Telnyx documents three more that it sends only when asked to (`eagerEndOfTurn`
 * and `turnResumed` with Deepgram Flux, `info` with the TeXML `events` attribute), and may add others.
 */
export interface IgnoredFrame {
  kind: "ignored";
  frameType: string;
}

/** A message that is not a JSON object with a `type`, or a known frame without the fields that give it meaning. */
export interface MalformedFrame {
  kind: "malformed";
  /** For the terminal. It names what is missing and repeats nothing from the frame, which may hold the Caller's words. */
  reason: string;
}

export type RelayFrame =
  | RelaySetup
  | RelayUtterance
  | RelayPartialPrompt
  | RelayInterrupt
  | RelayKeypad
  | RelayError
  | IgnoredFrame
  | MalformedFrame;

function malformed(reason: string): MalformedFrame {
  return { kind: "malformed", reason };
}

const KNOWN: Record<string, (frame: JsonObject) => RelayFrame> = {
  setup: (frame) => {
    const callControlId = text(frame.callControlId);
    if (callControlId === undefined) return malformed("the setup frame has no callControlId");
    const callSessionId = text(frame.callSessionId);
    if (callSessionId === undefined) return malformed("the setup frame has no callSessionId");
    return {
      kind: "setup",
      callControlId,
      callSessionId,
      relayConnectionId: text(frame.sessionId),
      direction: directionOf(frame.direction),
      from: text(frame.from),
      to: text(frame.to),
    };
  },
  prompt: (frame) => {
    if (typeof frame.voicePrompt !== "string") return malformed("the prompt frame has no voicePrompt");
    const said = frame.voicePrompt.trim();
    return frame.last === true ? { kind: "utterance", text: said, language: text(frame.lang) } : { kind: "partialPrompt", text: said };
  },
  interrupt: (frame) => ({
    kind: "interrupt",
    spokenBefore: text(frame.utteranceUntilInterrupt),
    afterMs: typeof frame.durationUntilInterruptMs === "number" ? frame.durationUntilInterruptMs : undefined,
  }),
  dtmf: (frame) => ({ kind: "keypad", digit: text(frame.digit) }),
  error: (frame) => ({ kind: "error", description: text(frame.description) ?? "" }),
};

/**
 * Reads one message from Telnyx on the Relay connection. Never throws: a message that cannot be read is `malformed`,
 * and a frame type with no use here is `ignored`.
 */
export function parseRelayFrame(raw: string | Uint8Array): RelayFrame {
  const frame = jsonObject(raw);
  if (!frame) return malformed("the frame is not a JSON object");
  const frameType = text(frame.type);
  if (frameType === undefined) return malformed("the frame has no type");
  const read = Object.hasOwn(KNOWN, frameType) ? KNOWN[frameType] : undefined;
  return read ? read(frame) : { kind: "ignored", frameType };
}

/**
 * The message that has Telnyx speak `reply` to the Caller: one `text` frame holding all of it, with `last: true` to say
 * the reply is complete (without `last`, Telnyx waits for more). Send the returned string as it is.
 *
 * A reply goes in one frame because only a finished Turn's reply is ever spoken. Telnyx documents no limit on the
 * length of a `text` frame: unconfirmed until the spike (#23).
 */
export function textFrame(reply: string): string {
  return JSON.stringify({ type: "text", token: reply, last: true });
}
