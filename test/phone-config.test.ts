import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readPhoneConfig } from "../src/phone-config.js";

/** A public key in the form the Telnyx portal shows it: the Base64 of 32 raw bytes. Made here, so it is nobody's. */
const PUBLIC_KEY = Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64");

const complete = {
  ANTHROPIC_API_KEY: "sk-ant-real",
  TELNYX_API_KEY: "KEY-telnyx-secret",
  TELNYX_PUBLIC_KEY: PUBLIC_KEY,
  PUBLIC_BASE_URL: "https://abc.ngrok.example",
};

function problemsOf(env: Record<string, string | undefined>): string[] {
  const result = readPhoneConfig(env);
  if (!("problems" in result)) throw new Error("expected problems");
  return result.problems;
}

function configOf(env: Record<string, string | undefined>) {
  const result = readPhoneConfig(env);
  if ("problems" in result) throw new Error(`unexpected problems: ${result.problems.join(" | ")}`);
  return result.config;
}

describe("readPhoneConfig", () => {
  it("gives the planned defaults when only the required variables are set", () => {
    expect(configOf(complete)).toMatchObject({
      port: 3000,
      voice: "Telnyx.Ultra.Callie",
      sttEngine: "Deepgram",
      sttModel: "deepgram/nova-3",
      language: "en",
      allowedCallers: undefined,
      relayBase: "wss://abc.ngrok.example",
      webhookUrl: "https://abc.ngrok.example/telnyx/webhooks",
    });
  });

  it("has one line for each required variable that is missing, empty or blank", () => {
    const lines = problemsOf({ TELNYX_API_KEY: "", TELNYX_PUBLIC_KEY: "  " });
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => line.split(" ")[0])).toEqual(["ANTHROPIC_API_KEY", "TELNYX_API_KEY", "TELNYX_PUBLIC_KEY", "PUBLIC_BASE_URL"]);
    for (const line of lines) expect(line).toContain("is not set");
  });

  it("counts the placeholder from .env.example as no Anthropic key", () => {
    expect(problemsOf({ ...complete, ANTHROPIC_API_KEY: "sk-ant-..." })[0]).toContain("ANTHROPIC_API_KEY is not set");
  });

  it("refuses a public key that is not the Base64 of 32 bytes, without repeating it", () => {
    const lines = problemsOf({ ...complete, TELNYX_PUBLIC_KEY: "not-a-key-at-all" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("TELNYX_PUBLIC_KEY");
    expect(lines[0]).not.toContain("not-a-key-at-all");
  });

  it.each(["http://abc.ngrok.example", "abc.ngrok.example", "https://abc.ngrok.example/some/path", "https://"])(
    "refuses a public address that is not an https:// address with nothing after the host (%s)",
    (address) => {
      const lines = problemsOf({ ...complete, PUBLIC_BASE_URL: address });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("PUBLIC_BASE_URL");
    },
  );

  it("takes a trailing slash and a port on the public address", () => {
    expect(configOf({ ...complete, PUBLIC_BASE_URL: "https://abc.example:8443/" }).relayBase).toBe("wss://abc.example:8443");
  });

  it("reads the allowed Callers as a comma-separated list of E.164 numbers", () => {
    const config = configOf({ ...complete, PHONE_ALLOWED_CALLERS: " +14155550100, +14155550101 ," });
    expect([...config.allowedCallers!]).toEqual(["+14155550100", "+14155550101"]);
  });

  it("treats an empty list as no list", () => {
    expect(configOf({ ...complete, PHONE_ALLOWED_CALLERS: "  " }).allowedCallers).toBeUndefined();
  });

  it("refuses a list with an entry that is not E.164, without repeating the entry", () => {
    const lines = problemsOf({ ...complete, PHONE_ALLOWED_CALLERS: "+14155550100, 415-555-0101" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("PHONE_ALLOWED_CALLERS");
    expect(lines[0]).not.toContain("415-555-0101");
  });

  it("reads the optional settings", () => {
    expect(
      configOf({
        ...complete,
        TELNYX_TTS_VOICE: "Telnyx.Ultra.Other",
        TELNYX_STT_ENGINE: "Telnyx",
        TELNYX_STT_MODEL: "openai/whisper-tiny",
        VOICE_LANGUAGE: "es",
        PORT: "8080",
      }),
    ).toMatchObject({ voice: "Telnyx.Ultra.Other", sttEngine: "Telnyx", sttModel: "openai/whisper-tiny", language: "es", port: 8080 });
  });

  it.each(["abc", "-1", "70000", "30.5"])("refuses a port that is not a number from 0 to 65535 (%s)", (port) => {
    expect(problemsOf({ ...complete, PORT: port })[0]).toContain("PORT");
  });

  it("refuses a Telnyx address that is neither https nor on this machine", () => {
    expect(problemsOf({ ...complete, TELNYX_BASE_URL: "http://example.com" })[0]).toContain("TELNYX_BASE_URL");
  });

  it("never repeats a key in any line", () => {
    const lines = problemsOf({ ...complete, TELNYX_API_KEY: "KEY-telnyx-secret", PORT: "abc", TELNYX_PUBLIC_KEY: "x" });
    expect(lines.join("\n")).not.toContain("KEY-telnyx-secret");
  });
});
