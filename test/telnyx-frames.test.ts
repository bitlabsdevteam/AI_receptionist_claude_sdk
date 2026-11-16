import { describe, expect, it } from "vitest";
import { parseRelayFrame, textFrame } from "../src/telnyx/frames.js";

/**
 * The frames below are the examples in Telnyx's Conversation Relay guide
 * (`developers.telnyx.com/docs/voice/programmable-voice/conversation-relay`), with the phone numbers replaced by ones
 * from the 555 range. None of them was captured from a real call.
 */

const CALL_CONTROL_ID = "v2:T02llQxIyaRkhfRKxgAP8nY511EhFLizdvdUKJiSw8d6A9BborherQ";
const CALL_SESSION_ID = "ff55a038-6f5d-11ef-9692-02420aeffb1f";

const setup = {
  type: "setup",
  sessionId: "7a7e6a4f-1d44-4f0c-b5d4-9f9bf3a5c1f2",
  accountSid: "1f1a8b6f-1234-4abc-9def-1234567890ab",
  callSid: CALL_CONTROL_ID,
  callControlId: CALL_CONTROL_ID,
  callSessionId: CALL_SESSION_ID,
  callLegId: "428c31b6-7af4-4b6f-92e7-7a7e6a4f1d44",
  from: "+13125550194",
  to: "+13125550156",
  direction: "inbound",
  callerName: "",
  callStatus: "active",
  customParameters: { customer_id: "customer_123" },
};

const raw = (frame: unknown) => JSON.stringify(frame);

describe("parseRelayFrame", () => {
  it("reads `setup`: which call the Relay connection is for", () => {
    expect(parseRelayFrame(raw(setup))).toEqual({
      kind: "setup",
      callControlId: CALL_CONTROL_ID,
      callSessionId: CALL_SESSION_ID,
      relayConnectionId: "7a7e6a4f-1d44-4f0c-b5d4-9f9bf3a5c1f2",
      direction: "inbound",
      from: "+13125550194",
      to: "+13125550156",
    });
  });

  it("reads a frame that arrived as bytes", () => {
    expect(parseRelayFrame(Buffer.from(raw(setup))).kind).toBe("setup");
  });

  it("takes the webhook's spelling of the direction as well as the Relay's, and leaves an unknown one as nothing", () => {
    expect(parseRelayFrame(raw({ ...setup, direction: "incoming" }))).toMatchObject({ kind: "setup", direction: "inbound" });
    expect(parseRelayFrame(raw({ ...setup, direction: "outgoing" }))).toMatchObject({ kind: "setup", direction: "outbound" });
    expect(parseRelayFrame(raw({ ...setup, direction: undefined, from: "" }))).toMatchObject({
      kind: "setup",
      direction: undefined,
      from: undefined,
    });
  });

  it("calls a `setup` malformed when it does not name the call", () => {
    expect(parseRelayFrame(raw({ ...setup, callControlId: undefined }))).toEqual({
      kind: "malformed",
      reason: "the setup frame has no callControlId",
    });
    expect(parseRelayFrame(raw({ ...setup, callSessionId: 7 }))).toEqual({
      kind: "malformed",
      reason: "the setup frame has no callSessionId",
    });
  });

  it("reads a final `prompt` as the Caller's utterance", () => {
    const prompt = { type: "prompt", voicePrompt: "hello there how are you", lang: "en", last: true };
    expect(parseRelayFrame(raw(prompt))).toEqual({ kind: "utterance", text: "hello there how are you", language: "en" });
  });

  it("does not read a `prompt` that is not final as an utterance", () => {
    const partial = { type: "prompt", voicePrompt: "I would like to book a table", lang: "en", last: false };
    expect(parseRelayFrame(raw(partial))).toEqual({ kind: "partialPrompt", text: "I would like to book a table" });

    // Only `last: true` makes a prompt final. Telnyx documents no prompt without `last`.
    for (const last of [undefined, null, "true", 1]) {
      expect(parseRelayFrame(raw({ ...partial, last })).kind, `last: ${String(last)}`).toBe("partialPrompt");
    }
  });

  it("trims an utterance, and leaves an empty one empty for the Call's rules to pass over", () => {
    expect(parseRelayFrame(raw({ type: "prompt", voicePrompt: "  yes please \n", last: true }))).toEqual({
      kind: "utterance",
      text: "yes please",
      language: undefined,
    });
    expect(parseRelayFrame(raw({ type: "prompt", voicePrompt: "   ", lang: "en", last: true }))).toMatchObject({
      kind: "utterance",
      text: "",
    });
  });

  it("calls a `prompt` with no words field malformed", () => {
    for (const voicePrompt of [undefined, null, 5, { text: "hi" }]) {
      expect(parseRelayFrame(raw({ type: "prompt", voicePrompt, last: true }))).toEqual({
        kind: "malformed",
        reason: "the prompt frame has no voicePrompt",
      });
    }
  });

  it("reads `interrupt`: what had been said, and for how long, when the Caller spoke over it", () => {
    const interrupt = { type: "interrupt", utteranceUntilInterrupt: "Welcome to Telnyx, how can I help", durationUntilInterruptMs: 1820 };
    expect(parseRelayFrame(raw(interrupt))).toEqual({
      kind: "interrupt",
      spokenBefore: "Welcome to Telnyx, how can I help",
      afterMs: 1820,
    });
    expect(parseRelayFrame(raw({ type: "interrupt" }))).toEqual({ kind: "interrupt", spokenBefore: undefined, afterMs: undefined });
    expect(parseRelayFrame(raw({ type: "interrupt", durationUntilInterruptMs: "soon" }))).toMatchObject({ afterMs: undefined });
  });

  it("reads a keypad press as a keypad press, never as an utterance", () => {
    expect(parseRelayFrame(raw({ type: "dtmf", digit: "1" }))).toEqual({ kind: "keypad", digit: "1" });
    expect(parseRelayFrame(raw({ type: "dtmf" }))).toEqual({ kind: "keypad", digit: undefined });
  });

  it("reads `error`: Telnyx's complaint about a frame we sent", () => {
    const error = { type: "error", description: "Invalid message: missing required field: token" };
    expect(parseRelayFrame(raw(error))).toEqual({ kind: "error", description: "Invalid message: missing required field: token" });
    expect(parseRelayFrame(raw({ type: "error" }))).toEqual({ kind: "error", description: "" });
  });

  it("ignores a frame type it has no use for, and says which it was", () => {
    const unused = [
      { type: "eagerEndOfTurn", voicePrompt: "I would like to book a table for two", lang: "en" },
      { type: "turnResumed" },
      { type: "info", name: "agentSpeaking", value: "on" },
      { type: "somethingNew", voicePrompt: "not an utterance", last: true },
      { type: "toString" },
    ];
    for (const frame of unused) {
      expect(parseRelayFrame(raw(frame))).toEqual({ kind: "ignored", frameType: frame.type });
    }
  });

  it("calls anything that is not a JSON object with a type malformed, and never throws", () => {
    const malformed = ["", "not json", '{"type": "prompt"', "null", "[]", "42", '"prompt"', raw({}), raw({ type: 7 }), raw({ type: "" })];
    for (const frame of malformed) {
      expect(parseRelayFrame(frame), `frame ${frame}`).toEqual({ kind: "malformed", reason: expect.any(String) });
    }
    expect(parseRelayFrame(new Uint8Array([0xff, 0xfe, 0x00]))).toEqual({ kind: "malformed", reason: expect.any(String) });
  });

  it("repeats nothing the Caller said in the reason it gives", () => {
    expect(JSON.stringify(parseRelayFrame('{"type":"prompt","voicePrompt":"my card number is 4242'))).not.toContain("4242");
    expect(JSON.stringify(parseRelayFrame(raw({ type: "prompt", voicePrompt: { said: "4242" }, last: true })))).not.toContain("4242");
  });
});

describe("textFrame", () => {
  it("builds one `text` frame that holds the whole reply and marks it complete", () => {
    const frame = textFrame("Hello, how can I help you today?");

    expect(typeof frame).toBe("string");
    expect(JSON.parse(frame)).toEqual({ type: "text", token: "Hello, how can I help you today?", last: true });
  });

  it("keeps quotes, new lines and other scripts intact", () => {
    const reply = 'She said "hi".\nÀ bientôt, さようなら.';
    expect(JSON.parse(textFrame(reply))).toEqual({ type: "text", token: reply, last: true });
  });
});
