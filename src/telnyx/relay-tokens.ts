import { randomBytes } from "node:crypto";

/** How long a token may be used for, from the moment it was issued. */
export const RELAY_TOKEN_TTL_MS = 30_000;

/**
 * The secret that goes in the address Telnyx connects the Relay to (`wss://.../telnyx/relay/<token>`), because the
 * Relay connection carries no signature that is documented. A token is random, issued for one Call, valid for 30
 * seconds and usable once. Nothing here is written to a log.
 */
export class RelayTokens {
  readonly #now: () => number;
  readonly #issued = new Map<string, { callId: string; expiresAt: number }>();

  /** `now` reads the time in ms. */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get size(): number {
    return this.#issued.size;
  }

  /** A new token for `callId`. Tokens past their time are dropped at this point, so they are not kept for ever. */
  issue(callId: string): string {
    const now = this.#now();
    for (const [token, entry] of this.#issued) if (entry.expiresAt < now) this.#issued.delete(token);
    const token = randomBytes(32).toString("base64url");
    this.#issued.set(token, { callId, expiresAt: now + RELAY_TOKEN_TTL_MS });
    return token;
  }

  /** The Call a token was issued for, once. An unknown, used or expired token gives undefined, and a used one stays used. */
  redeem(token: string): string | undefined {
    const entry = this.#issued.get(token);
    if (!entry) return undefined;
    this.#issued.delete(token);
    return entry.expiresAt >= this.#now() ? entry.callId : undefined;
  }

  /** Drops what was issued for a Call that is over. */
  forget(callId: string): void {
    for (const [token, entry] of this.#issued) if (entry.callId === callId) this.#issued.delete(token);
  }
}
