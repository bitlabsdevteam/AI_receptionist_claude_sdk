import type { PhoneLine } from "../src/adapters/phone.js";

/** Something the rules of a phone Call asked the line to say, and on which Call. */
export interface Said {
  callId: string;
  text: string;
}

/**
 * Stand-in for the phone line. It records everything it was asked to say, in order, and says nothing. What happens on
 * the line (a call arriving, the Caller speaking or hanging up) is scripted by the test, which reports each event to
 * `PhoneCalls` itself and then waits with `settled()`.
 */
export class FakePhoneLine implements PhoneLine {
  readonly said: Said[] = [];

  say(callId: string, text: string): void {
    this.said.push({ callId, text });
  }

  /** What the Caller on one Call was told, in order. */
  saidOn(callId: string): string[] {
    return this.said.filter((said) => said.callId === callId).map((said) => said.text);
  }
}

/**
 * Waits until everything already under way has gone as far as it can. The engine, `FakeClaude` and the in-memory store
 * use promises only, with no timers and no I/O, so one turn of the event loop is enough.
 */
export function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
