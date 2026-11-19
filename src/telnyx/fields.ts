/** Reading what Telnyx sends, a field at a time, without trusting its shape. Shared by the webhook and the Relay parsers. */

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON object in `raw`, or undefined when `raw` is not JSON or is JSON of another kind. Never throws. */
export function jsonObject(raw: string | Uint8Array): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    // The parse error is dropped: it can quote the text, and the text is the Caller's or Telnyx's.
    return undefined;
  }
}

/** A field that holds text. Anything else, and an empty string, is undefined. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Which way a call goes, in one spelling for the whole module. */
export type CallDirection = "inbound" | "outbound";

/**
 * Telnyx spells the direction two ways: webhooks say `incoming` and `outgoing`, and the Relay's `setup` frame says
 * `inbound` (its docs show no outbound example). Both spellings are taken in both places, and anything else is
 * undefined, so a call is never taken for inbound by default.
 */
export function directionOf(value: unknown): CallDirection | undefined {
  if (value === "incoming" || value === "inbound") return "inbound";
  if (value === "outgoing" || value === "outbound") return "outbound";
  return undefined;
}
