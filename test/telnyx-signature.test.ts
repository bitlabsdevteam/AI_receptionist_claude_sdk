import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkWebhookSignature, isTelnyxPublicKey, SIGNATURE_TOLERANCE_SECS } from "../src/telnyx/signature.js";

/**
 * The check is tested against a key pair made here, so no real Telnyx key is involved. The signing below follows what
 * Telnyx documents: Ed25519 over `<timestamp>|<raw body>`, the signature in Base64, the public key as the Base64 of its
 * 32 raw bytes (the form the portal shows it in).
 */

function keyPair(): { publicKey: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return { publicKey: raw.toString("base64"), privateKey };
}

const { publicKey, privateKey } = keyPair();

/** 2026-11-16T12:00:00Z, in seconds and in the milliseconds a clock gives. */
const NOW_SECS = 1_794_830_400;
const NOW_MS = NOW_SECS * 1000;

const BODY = JSON.stringify({ data: { event_type: "call.initiated", id: "event-1", payload: { from: "+12025550133" } } });

function signatureOf(timestamp: string, body: string, key: KeyObject = privateKey): string {
  return sign(null, Buffer.from(`${timestamp}|${body}`), key).toString("base64");
}

/** The headers of a webhook signed at `timestamp`, lower-cased as `node:http` gives them. */
function signedHeaders(body: string, timestamp = String(NOW_SECS)): Record<string, string> {
  return { "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": signatureOf(timestamp, body) };
}

describe("checkWebhookSignature", () => {
  it("accepts a request signed with the account's key, whether the body is a string or bytes", () => {
    const headers = signedHeaders(BODY);

    expect(checkWebhookSignature({ rawBody: BODY, headers, publicKey, nowMs: NOW_MS })).toEqual({ ok: true });
    expect(checkWebhookSignature({ rawBody: Buffer.from(BODY), headers, publicKey, nowMs: NOW_MS })).toEqual({ ok: true });
  });

  it("rejects a changed body", () => {
    const headers = signedHeaders(BODY);
    const changed = BODY.replace("+12025550133", "+12025550199");

    expect(checkWebhookSignature({ rawBody: changed, headers, publicKey, nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: "the signature does not match",
    });
  });

  it("rejects a changed timestamp, even one that is still fresh", () => {
    const headers = { ...signedHeaders(BODY), "telnyx-timestamp": String(NOW_SECS + 1) };

    expect(checkWebhookSignature({ rawBody: BODY, headers, publicKey, nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: "the signature does not match",
    });
  });

  it("rejects a request signed with another key", () => {
    const other = keyPair();
    const timestamp = String(NOW_SECS);
    const headers = { "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": signatureOf(timestamp, BODY, other.privateKey) };

    expect(checkWebhookSignature({ rawBody: BODY, headers, publicKey, nowMs: NOW_MS }).ok).toBe(false);
  });

  it("rejects a correctly signed request whose timestamp is more than 5 minutes old or ahead", () => {
    expect(SIGNATURE_TOLERANCE_SECS).toBe(300);
    const check = (timestamp: number) =>
      checkWebhookSignature({ rawBody: BODY, headers: signedHeaders(BODY, String(timestamp)), publicKey, nowMs: NOW_MS });

    expect(check(NOW_SECS - 300)).toEqual({ ok: true });
    expect(check(NOW_SECS + 300)).toEqual({ ok: true });
    expect(check(NOW_SECS - 301)).toEqual({ ok: false, reason: "the timestamp is more than 300 s from now" });
    expect(check(NOW_SECS + 301)).toEqual({ ok: false, reason: "the timestamp is more than 300 s from now" });
  });

  it("rejects a request with a header missing or empty", () => {
    const headers = signedHeaders(BODY);
    const without = (name: string) => Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));

    expect(checkWebhookSignature({ rawBody: BODY, headers: without("telnyx-signature-ed25519"), publicKey, nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: "the telnyx-signature-ed25519 header is missing",
    });
    expect(checkWebhookSignature({ rawBody: BODY, headers: without("telnyx-timestamp"), publicKey, nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: "the telnyx-timestamp header is missing",
    });
    expect(checkWebhookSignature({ rawBody: BODY, headers: {}, publicKey, nowMs: NOW_MS }).ok).toBe(false);
    expect(
      checkWebhookSignature({ rawBody: BODY, headers: { ...headers, "telnyx-signature-ed25519": "" }, publicKey, nowMs: NOW_MS }).ok,
    ).toBe(false);
  });

  it("finds the headers whatever their case, and rejects one that was sent twice", () => {
    const headers = signedHeaders(BODY);
    const titled = {
      "Telnyx-Timestamp": headers["telnyx-timestamp"],
      "Telnyx-Signature-Ed25519": headers["telnyx-signature-ed25519"],
    };
    expect(checkWebhookSignature({ rawBody: BODY, headers: titled, publicKey, nowMs: NOW_MS })).toEqual({ ok: true });

    const twice = { ...headers, "telnyx-signature-ed25519": [headers["telnyx-signature-ed25519"]!, "AAAA"] };
    expect(checkWebhookSignature({ rawBody: BODY, headers: twice, publicKey, nowMs: NOW_MS }).ok).toBe(false);
  });

  it("rejects a timestamp that is not a whole number of seconds", () => {
    for (const timestamp of ["", "soon", "1794830400.5", "-1794830400", " 1794830400", "1e9"]) {
      const headers = { "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": signatureOf(timestamp, BODY) };
      expect(checkWebhookSignature({ rawBody: BODY, headers, publicKey, nowMs: NOW_MS }).ok, `timestamp "${timestamp}"`).toBe(false);
    }
  });

  it("rejects a signature that is not 64 bytes of Base64", () => {
    for (const signature of ["not base64 at all", Buffer.alloc(63).toString("base64"), Buffer.alloc(65).toString("base64")]) {
      const headers = { "telnyx-timestamp": String(NOW_SECS), "telnyx-signature-ed25519": signature };
      expect(checkWebhookSignature({ rawBody: BODY, headers, publicKey, nowMs: NOW_MS })).toEqual({
        ok: false,
        reason: "the signature is not 64 bytes",
      });
    }
  });

  it("fails closed on a malformed public key, and never throws", () => {
    const headers = signedHeaders(BODY);
    for (const key of ["", "not a key", Buffer.alloc(31, 1).toString("base64"), Buffer.alloc(33, 1).toString("base64")]) {
      expect(checkWebhookSignature({ rawBody: BODY, headers, publicKey: key, nowMs: NOW_MS }), `key "${key}"`).toEqual({
        ok: false,
        reason: "TELNYX_PUBLIC_KEY is not the Base64 of 32 bytes",
      });
    }
  });

  it("names no part of the request or the key in the reason", () => {
    const failures = [
      checkWebhookSignature({ rawBody: "tampered", headers: signedHeaders(BODY), publicKey, nowMs: NOW_MS }),
      checkWebhookSignature({ rawBody: BODY, headers: signedHeaders(BODY, String(NOW_SECS - 9999)), publicKey, nowMs: NOW_MS }),
      checkWebhookSignature({ rawBody: BODY, headers: signedHeaders(BODY), publicKey: `${publicKey}AAAA`, nowMs: NOW_MS }),
    ];
    for (const failure of failures) {
      expect(failure.ok).toBe(false);
      const reason = failure.ok ? "" : failure.reason;
      expect(reason).not.toContain(publicKey);
      expect(reason).not.toContain("tampered");
      expect(reason).not.toContain(String(NOW_SECS - 9999));
    }
  });
});

describe("isTelnyxPublicKey", () => {
  it("is true for the Base64 of 32 bytes, as the portal shows the key, and false for anything else", () => {
    expect(isTelnyxPublicKey(publicKey)).toBe(true);
    expect(isTelnyxPublicKey(` ${publicKey}\n`)).toBe(true);
    expect(isTelnyxPublicKey("")).toBe(false);
    expect(isTelnyxPublicKey("KEY0123")).toBe(false);
    expect(isTelnyxPublicKey(Buffer.alloc(64, 1).toString("base64"))).toBe(false);
  });
});
