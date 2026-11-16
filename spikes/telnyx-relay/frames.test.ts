import { describe, expect, it } from "vitest";
import { CLOSING_LINE, GREETING, LONG_REPLY, readFrame, repliesTo, textFrame } from "./frames.js";

/** The frames are the ones in Telnyx's Conversation Relay guide, copied from its examples. */

const SETUP = JSON.stringify({
  type: "setup",
  sessionId: "7a7e6a4f-1d44-4f0c-b5d4-9f9bf3a5c1f2",
  callControlId: "v2:T02llQxIyaRkhfRKxgAP8nY511EhFLizdvdUKJiSw8d6A9BborherQ",
  callSessionId: "ff55a038-6f5d-11ef-9692-02420aeffb1f",
  from: "+13122010094",
  to: "+13122123456",
  direction: "inbound",
  customParameters: {},
});

function replies(raw: string) {
  return repliesTo(readFrame(raw));
}

describe("repliesTo", () => {
  it("answers setup with the greeting, as one finished text frame", () => {
    expect(replies(SETUP)).toEqual([{ type: "text", token: GREETING, last: true }]);
  });

  it("echoes a final prompt", () => {
    const prompt = '{"type":"prompt","voicePrompt":"hello there how are you","lang":"en","last":true}';
    expect(replies(prompt)).toEqual([{ type: "text", token: "You said: hello there how are you", last: true }]);
  });

  it("says nothing to a partial prompt", () => {
    expect(replies('{"type":"prompt","voicePrompt":"I would like to book a table","lang":"en","last":false}')).toEqual([]);
  });

  it("says nothing to a prompt that does not say it is final", () => {
    expect(replies('{"type":"prompt","voicePrompt":"hello","lang":"en"}')).toEqual([]);
  });

  it("says nothing to a final prompt with no words in it", () => {
    expect(replies('{"type":"prompt","voicePrompt":"  ","lang":"en","last":true}')).toEqual([]);
    expect(replies('{"type":"prompt","lang":"en","last":true}')).toEqual([]);
  });

  it.each([
    '{"type":"interrupt","utteranceUntilInterrupt":"Welcome to Telnyx, how can I help","durationUntilInterruptMs":1820}',
    '{"type":"dtmf","digit":"1"}',
    '{"type":"error","description":"Invalid message: missing required field: token"}',
    '{"type":"eagerEndOfTurn","voicePrompt":"I would like to book a table for two","lang":"en"}',
    '{"type":"turnResumed"}',
    '{"type":"info","name":"agentSpeaking","value":"on"}',
    '{"type":"somethingNew","x":1}',
  ])("says nothing to %s", (raw) => {
    expect(replies(raw)).toEqual([]);
  });
});

describe("readFrame", () => {
  it("keeps every field of a frame it knows, so the log shows what Telnyx sent", () => {
    const frame = readFrame('{"type":"interrupt","utteranceUntilInterrupt":"Welcome","durationUntilInterruptMs":1820}');
    expect(frame).toEqual({
      type: "interrupt",
      known: true,
      body: { type: "interrupt", utteranceUntilInterrupt: "Welcome", durationUntilInterruptMs: 1820 },
    });
  });

  it("marks a type that is not in Telnyx's guide as unknown, and keeps it", () => {
    expect(readFrame('{"type":"somethingNew","x":1}')).toEqual({
      type: "somethingNew",
      known: false,
      body: { type: "somethingNew", x: 1 },
    });
  });

  it.each(["not json", "[1,2]", '"text"', "{}", '{"type":7}', ""])("does not throw on %j and keeps the raw text", (raw) => {
    expect(readFrame(raw)).toEqual({ type: "unreadable", known: false, raw });
    expect(replies(raw)).toEqual([]);
  });
});

describe("the fixed replies", () => {
  it("has a long reply of about 600 characters that ends on a word the Caller can listen for", () => {
    expect(LONG_REPLY.length).toBeGreaterThanOrEqual(580);
    expect(LONG_REPLY.length).toBeLessThanOrEqual(640);
    expect(LONG_REPLY.endsWith("pineapple.")).toBe(true);
  });

  it("has no markdown or line breaks in anything that is spoken", () => {
    for (const line of [GREETING, LONG_REPLY, CLOSING_LINE]) expect(line).not.toMatch(/[*_#`\n]/);
  });

  it("builds a finished text frame", () => {
    expect(textFrame("Hello.")).toEqual({ type: "text", token: "Hello.", last: true });
  });
});
