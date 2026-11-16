import { describe, expect, it } from "vitest";
import { RELAY_TOKEN_TTL_MS, RelayTokens } from "../src/telnyx/relay-tokens.js";

describe("RelayTokens", () => {
  function tokens(start = 1000) {
    let now = start;
    return { store: new RelayTokens(() => now), advance: (ms: number) => void (now += ms) };
  }

  it("lives 30 seconds", () => {
    expect(RELAY_TOKEN_TTL_MS).toBe(30_000);
  });

  it("gives back the Call a token was issued for", () => {
    const { store } = tokens();
    const token = store.issue("call-1");

    expect(store.redeem(token)).toBe("call-1");
  });

  it("can be used once", () => {
    const { store } = tokens();
    const token = store.issue("call-1");

    store.redeem(token);

    expect(store.redeem(token)).toBeUndefined();
  });

  it("does not know a token it did not issue", () => {
    const { store } = tokens();
    store.issue("call-1");

    expect(store.redeem("made-up")).toBeUndefined();
    expect(store.redeem("")).toBeUndefined();
  });

  it("is valid up to 30 seconds after it was issued, and not a millisecond longer", () => {
    const { store, advance } = tokens();
    const last = store.issue("call-1");
    const late = store.issue("call-2");

    advance(RELAY_TOKEN_TTL_MS);
    expect(store.redeem(last)).toBe("call-1");
    advance(1);
    expect(store.redeem(late)).toBeUndefined();
  });

  it("is random and distinct for each issue, for the same Call too", () => {
    const { store } = tokens();
    const issued = new Set(Array.from({ length: 50 }, () => store.issue("call-1")));

    expect(issued.size).toBe(50);
    for (const token of issued) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("forgets the tokens of a Call when it is over", () => {
    const { store } = tokens();
    const token = store.issue("call-1");
    const other = store.issue("call-2");

    store.forget("call-1");

    expect(store.redeem(token)).toBeUndefined();
    expect(store.redeem(other)).toBe("call-2");
  });

  it("does not keep expired tokens for ever", () => {
    const { store, advance } = tokens();
    for (let i = 0; i < 10; i++) store.issue(`call-${i}`);

    advance(RELAY_TOKEN_TTL_MS + 1);
    store.issue("call-new");

    expect(store.size).toBe(1);
  });
});
