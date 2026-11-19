import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * The signature Telnyx puts on a version 2 webhook: Ed25519 over `<telnyx-timestamp>|<raw body>`, sent in Base64 in
 * `telnyx-signature-ed25519`, with the Unix time in seconds in `telnyx-timestamp`. The public key is the account's, and
 * the portal shows it as the Base64 of its 32 raw bytes.
 *
 * Telnyx's docs give no replay window ("reject signatures outside the application's replay window"). Its Node SDK
 * allows 300 seconds either way, and so does this.
 */
export const SIGNATURE_TOLERANCE_SECS = 300;

/** Whether a webhook may be trusted. `reason` is for the terminal: it never repeats the body, a header or the key. */
export type SignatureCheck = { ok: true } | { ok: false; reason: string };

/** Request headers as `node:http` gives them: a repeated header arrives as an array. */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface WebhookToCheck {
  /** The body exactly as it arrived. A body that was parsed and written out again will not match. */
  rawBody: string | Uint8Array;
  headers: WebhookHeaders;
  /** `TELNYX_PUBLIC_KEY`: the Base64 of 32 bytes. */
  publicKey: string;
  /** The time now, in milliseconds, from the caller's clock. */
  nowMs: number;
}

const SIGNATURE_HEADER = "telnyx-signature-ed25519";
const TIMESTAMP_HEADER = "telnyx-timestamp";

/** Standard Base64, padded or not, of exactly 32 and of exactly 64 bytes. */
const KEY_BASE64 = /^[A-Za-z0-9+/]{43}=?$/;
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}(?:==)?$/;

/** The portal's Base64 public key as a key Node can verify with, or undefined when it is not 32 bytes of Base64. */
function publicKeyFrom(base64: string): KeyObject | undefined {
  const trimmed = base64.trim();
  if (!KEY_BASE64.test(trimmed)) return undefined;
  try {
    const x = Buffer.from(trimmed, "base64").toString("base64url");
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  } catch {
    return undefined;
  }
}

/** Whether `value` has the form of a Telnyx public key, so a program can refuse to start on a mistyped one. */
export function isTelnyxPublicKey(value: string): boolean {
  return publicKeyFrom(value) !== undefined;
}

/** The one value of a header, whatever the case of its name. Undefined when it is absent, empty or sent twice. */
function header(headers: WebhookHeaders, name: string): string | undefined {
  const found = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  if (found.length !== 1) return undefined;
  const value = found[0]![1];
  const one = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  return one === undefined || one === "" ? undefined : one;
}

/**
 * Checks that a webhook was signed by Telnyx and is fresh. Everything else fails closed, and nothing throws: a missing,
 * empty or repeated header, a timestamp that is not a whole number of seconds or is more than
 * `SIGNATURE_TOLERANCE_SECS` from `nowMs` either way, a signature that is not 64 bytes or does not match, and a public
 * key that is not the Base64 of 32 bytes.
 */
export function checkWebhookSignature({ rawBody, headers, publicKey, nowMs }: WebhookToCheck): SignatureCheck {
  const key = publicKeyFrom(publicKey);
  if (!key) return { ok: false, reason: "TELNYX_PUBLIC_KEY is not the Base64 of 32 bytes" };

  const signature = header(headers, SIGNATURE_HEADER);
  if (signature === undefined) return { ok: false, reason: `the ${SIGNATURE_HEADER} header is missing` };
  const timestamp = header(headers, TIMESTAMP_HEADER);
  if (timestamp === undefined) return { ok: false, reason: `the ${TIMESTAMP_HEADER} header is missing` };

  if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))) {
    return { ok: false, reason: "the timestamp is not a whole number of seconds" };
  }
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECS) {
    return { ok: false, reason: `the timestamp is more than ${SIGNATURE_TOLERANCE_SECS} s from now` };
  }
  if (!SIGNATURE_BASE64.test(signature)) return { ok: false, reason: "the signature is not 64 bytes" };

  // The timestamp is signed as the text of the header, and the body as the bytes that arrived.
  const signed = Buffer.concat([Buffer.from(`${timestamp}|`), typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody]);
  try {
    if (verify(null, signed, key, Buffer.from(signature, "base64"))) return { ok: true };
  } catch {
    // A signature Node cannot even read counts as one that does not match.
  }
  return { ok: false, reason: "the signature does not match" };
}
