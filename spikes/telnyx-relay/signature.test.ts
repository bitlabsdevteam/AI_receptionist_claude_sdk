import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkRelayHandshake, checkWebhookSignature } from "./signature.js";

/**
 * Telnyx signs `<telnyx-timestamp>|<raw body>` with the account's Ed25519 key and sends the signature in Base64. The
 * portal shows the public key as the Base64 of its 32 raw bytes. These tests sign the same way with a throwaway key.
 */

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = rawBase64(publicKey);
const NOW = 1_800_000_000;
const BODY = '{"data":{"event_type":"call.initiated","id":"e1","payload":{"from":"+12025550133"}}}';

function rawBase64(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  return Buffer.from(jwk.x as string, "base64url").toString("base64");
}

function signed(text: string, key: KeyObject = privateKey): string {
  return sign(null, Buffer.from(text), key).toString("base64");
}

function headers(timestamp: number | string, body = BODY): Record<string, string> {
  return { "telnyx-timestamp": String(timestamp), "telnyx-signature-ed25519": signed(`${timestamp}|${body}`) };
}

describe("checkWebhookSignature", () => {
  it("accepts a body signed by the account's key", () => {
    expect(checkWebhookSignature(BODY, headers(NOW), PUBLIC_KEY, NOW)).toEqual({ ok: true });
  });

  it("rejects a body that was changed after signing", () => {
    const result = checkWebhookSignature(BODY.replace("0133", "0199"), headers(NOW), PUBLIC_KEY, NOW);
    expect(result).toEqual({ ok: false, reason: "signature does not match" });
  });

  it("rejects a signature made with another key", () => {
    const other = generateKeyPairSync("ed25519");
    const forged = {
      "telnyx-timestamp": String(NOW),
      "telnyx-signature-ed25519": signed(`${NOW}|${BODY}`, other.privateKey),
    };
    expect(checkWebhookSignature(BODY, forged, PUBLIC_KEY, NOW)).toEqual({
      ok: false,
      reason: "signature does not match",
    });
  });

  it("rejects a signature over the body alone, without the timestamp", () => {
    const bare = { "telnyx-timestamp": String(NOW), "telnyx-signature-ed25519": signed(BODY) };
    expect(checkWebhookSignature(BODY, bare, PUBLIC_KEY, NOW).ok).toBe(false);
  });

  it("accepts a timestamp five minutes off and rejects one a second further", () => {
    expect(checkWebhookSignature(BODY, headers(NOW - 300), PUBLIC_KEY, NOW).ok).toBe(true);
    expect(checkWebhookSignature(BODY, headers(NOW + 300), PUBLIC_KEY, NOW).ok).toBe(true);
    expect(checkWebhookSignature(BODY, headers(NOW - 301), PUBLIC_KEY, NOW)).toEqual({
      ok: false,
      reason: "timestamp is more than 300 s off",
    });
    expect(checkWebhookSignature(BODY, headers(NOW + 301), PUBLIC_KEY, NOW).ok).toBe(false);
  });

  it("rejects a missing header, each by name", () => {
    const { "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": signature } = headers(NOW);
    expect(checkWebhookSignature(BODY, { "telnyx-timestamp": timestamp! }, PUBLIC_KEY, NOW)).toEqual({
      ok: false,
      reason: "telnyx-signature-ed25519 header is missing",
    });
    expect(checkWebhookSignature(BODY, { "telnyx-signature-ed25519": signature! }, PUBLIC_KEY, NOW)).toEqual({
      ok: false,
      reason: "telnyx-timestamp header is missing",
    });
  });

  it("rejects a timestamp that is not a whole number of seconds", () => {
    expect(checkWebhookSignature(BODY, headers("soon"), PUBLIC_KEY, NOW)).toEqual({
      ok: false,
      reason: "telnyx-timestamp is not a number",
    });
  });

  it("rejects a signature that is not 64 bytes", () => {
    const short = { "telnyx-timestamp": String(NOW), "telnyx-signature-ed25519": "AAAA" };
    expect(checkWebhookSignature(BODY, short, PUBLIC_KEY, NOW)).toEqual({
      ok: false,
      reason: "signature is not 64 bytes",
    });
  });

  it("checks the exact bytes received, not a re-serialised body", () => {
    const spaced = '{ "data": { "id": "e1" } }';
    expect(checkWebhookSignature(Buffer.from(spaced), headers(NOW, spaced), PUBLIC_KEY, NOW).ok).toBe(true);
    expect(checkWebhookSignature('{"data":{"id":"e1"}}', headers(NOW, spaced), PUBLIC_KEY, NOW).ok).toBe(false);
  });

  it("says so when the public key is not 32 bytes of Base64", () => {
    expect(() => checkWebhookSignature(BODY, headers(NOW), "not-a-key", NOW)).toThrow(/TELNYX_PUBLIC_KEY/);
  });
});

describe("checkRelayHandshake", () => {
  const URL = "wss://example.test/telnyx/relay/abc123";

  it("reports an unsigned handshake as absent", () => {
    expect(checkRelayHandshake({ host: "example.test" }, URL, PUBLIC_KEY, NOW)).toBe("absent");
  });

  it("reports a handshake signed over `<timestamp>|<url>` as valid, the way Telnyx signs a media stream", () => {
    const signedHeaders = {
      "telnyx-timestamp": String(NOW),
      "telnyx-signature-ed25519": signed(`${NOW}|${URL}`),
    };
    expect(checkRelayHandshake(signedHeaders, URL, PUBLIC_KEY, NOW)).toBe("valid");
  });

  it("reports a handshake signed over something else as invalid", () => {
    const signedHeaders = {
      "telnyx-timestamp": String(NOW),
      "telnyx-signature-ed25519": signed(`${NOW}|wss://example.test/other`),
    };
    expect(checkRelayHandshake(signedHeaders, URL, PUBLIC_KEY, NOW)).toBe("invalid: signature does not match");
  });
});
