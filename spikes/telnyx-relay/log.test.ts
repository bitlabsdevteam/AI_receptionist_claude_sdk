import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMasker, openLog } from "./log.js";

const KEY = "KEY0123456789abcdefSECRET";

describe("the masker", () => {
  it("masks an E.164 number to its last four digits wherever it is", () => {
    const { mask } = createMasker();
    expect(mask({ payload: { from: "+12025550133", to: "+12025550131" }, note: "call from +12025550133 ended" })).toEqual({
      payload: { from: "+***0133", to: "+***0131" },
      note: "call from +***0133 ended",
    });
  });

  it("masks a number inside a SIP address and inside an array", () => {
    const { mask } = createMasker();
    expect(mask(["sip:+12025550133@sip.telnyx.com", { x: ["+442071838750"] }])).toEqual([
      "sip:+***0133@sip.telnyx.com",
      { x: ["+***8750"] },
    ]);
  });

  it("masks a number with no plus sign when the field is one that holds a number", () => {
    const { mask } = createMasker();
    expect(mask({ from: "12025550133", to: "2025550131", From: "12025550133", caller_id_number: "12025550133" })).toEqual({
      from: "***0133",
      to: "***0131",
      From: "***0133",
      caller_id_number: "***0133",
    });
  });

  it("masks a number it was told about in any form, even inside what the Caller said", () => {
    const { mask, addNumber } = createMasker();
    addNumber("+12025550133");
    expect(mask({ voicePrompt: "my number is 2025550133, or (202) 555-0133, or 1 202 555 0133" })).toEqual({
      voicePrompt: "my number is ***0133, or ***0133, or ***0133",
    });
  });

  it("hides the Caller's name", () => {
    const { mask } = createMasker();
    expect(mask({ caller_id_name: "Jane Example", callerName: "Jane Example" })).toEqual({
      caller_id_name: "[masked]",
      callerName: "[masked]",
    });
    expect(mask({ callerName: "" })).toEqual({ callerName: "" });
  });

  it("redacts a secret wherever it appears", () => {
    const { mask, addSecret } = createMasker();
    addSecret(KEY);
    expect(mask({ authorization: `Bearer ${KEY}`, error: `request with ${KEY} failed` })).toEqual({
      authorization: "Bearer [redacted]",
      error: "request with [redacted] failed",
    });
  });

  it("leaves ids, timestamps and signatures as they are", () => {
    const { mask } = createMasker();
    const record = {
      connection_id: "1240401930086254526",
      occurred_at: "2026-11-16T12:00:00.123456789Z",
      headers: {
        "telnyx-timestamp": "1800000000",
        "telnyx-signature-ed25519": "q+1234567890abc/+12345678Zz==",
      },
      call_control_id: "v3:T02llQxIyaRkhfRKxgAP8nY511EhFLizdvdUKJiSw8d6A9BborherQ",
      durationUntilInterruptMs: 1820,
      from: "anonymous",
    };
    expect(mask(record)).toEqual(record);
  });
});

describe("the log file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spike-log-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes one JSON object per line, each with a millisecond timestamp, masked", () => {
    const path = join(dir, "nested", "spike.jsonl");
    const times = [1_800_000_000_123, 1_800_000_000_456];
    const log = openLog(path, () => times.shift()!);
    log.addSecret(KEY);
    log.write("webhook", { body: { data: { payload: { from: "+12025550133" } } } });
    log.write("command", { name: "answer", note: KEY });

    const lines = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
    expect(lines).toEqual([
      {
        ts: "2027-01-15T08:00:00.123Z",
        t_ms: 1_800_000_000_123,
        kind: "webhook",
        body: { data: { payload: { from: "+***0133" } } },
      },
      { ts: "2027-01-15T08:00:00.456Z", t_ms: 1_800_000_000_456, kind: "command", name: "answer", note: "[redacted]" },
    ]);
  });

  it("hands back the masked record, so the terminal shows no more than the file", () => {
    const log = openLog(join(dir, "spike.jsonl"), () => 1_800_000_000_000);
    expect(log.write("webhook", { from: "+12025550133" })).toMatchObject({ kind: "webhook", from: "+***0133" });
  });
});
