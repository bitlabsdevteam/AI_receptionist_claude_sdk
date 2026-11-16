import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Telnyx's webhook signature: Ed25519 over `<telnyx-timestamp>|<raw body>`, sent in Base64 in
 * `telnyx-signature-ed25519`. The public key is the Base64 of 32 raw bytes, as the portal shows it. Telnyx's docs give
 * no replay window, and its Node SDK uses 300 seconds, so that is what is used here.
 */

export const TOLERANCE_SECS = 300;

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

/** Header names arrive lower-cased from `node:http`, and a repeated header as an array. */
export type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The portal's Base64 public key as a key Node can verify with. Throws when it is not 32 bytes. */
export function publicKeyFrom(base64: string): KeyObject {
  const raw = Buffer.from(base64.trim(), "base64");
  if (raw.length !== 32) {
    throw new Error(`TELNYX_PUBLIC_KEY must be the Base64 of 32 bytes, as the portal shows it (got ${raw.length} bytes).`);
  }
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

function checkSigned(
  signedText: (timestamp: string) => Buffer,
  headers: Headers,
  publicKey: string,
  nowSecs: number,
): SignatureCheck {
  const key = publicKeyFrom(publicKey);
  const timestamp = header(headers, "telnyx-timestamp");
  const signature = header(headers, "telnyx-signature-ed25519");
  if (timestamp === undefined) return { ok: false, reason: "telnyx-timestamp header is missing" };
  if (signature === undefined) return { ok: false, reason: "telnyx-signature-ed25519 header is missing" };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: "telnyx-timestamp is not a number" };
  if (Math.abs(nowSecs - Number(timestamp)) > TOLERANCE_SECS) {
    return { ok: false, reason: `timestamp is more than ${TOLERANCE_SECS} s off` };
  }
  const signatureBytes = Buffer.from(signature, "base64");
  if (signatureBytes.length !== 64) return { ok: false, reason: "signature is not 64 bytes" };
  return verify(null, signedText(timestamp), key, signatureBytes)
    ? { ok: true }
    : { ok: false, reason: "signature does not match" };
}

/** Checks a webhook. `rawBody` must be the bytes as received, never a re-serialised object. */
export function checkWebhookSignature(
  rawBody: Buffer | string,
  headers: Headers,
  publicKey: string,
  nowSecs: number,
): SignatureCheck {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  return checkSigned((timestamp) => Buffer.concat([Buffer.from(`${timestamp}|`), body]), headers, publicKey, nowSecs);
}

/**
 * Experiment 1: is the Relay connection's handshake signed? Telnyx's docs do not say. They do say a media stream's
 * handshake is signed over `<telnyx-timestamp>|<stream_url>`, so this tries that scheme with the exact URL the Relay was
 * started with. `absent` means neither header came. It only reports: the spike accepts the connection either way.
 */
export function checkRelayHandshake(headers: Headers, relayUrl: string, publicKey: string, nowSecs: number): string {
  if (header(headers, "telnyx-timestamp") === undefined && header(headers, "telnyx-signature-ed25519") === undefined) {
    return "absent";
  }
  const check = checkSigned((timestamp) => Buffer.from(`${timestamp}|${relayUrl}`), headers, publicKey, nowSecs);
  return check.ok ? "valid" : `invalid: ${check.reason}`;
}
