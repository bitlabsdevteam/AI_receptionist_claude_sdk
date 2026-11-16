import type { FlowEngine } from "../engine/engine.js";
import type { TurnResult } from "../engine/turn.js";

/** What the rules of a phone Call may ask of the phone line. */
export interface PhoneLine {
  /** Says `text` to the Caller on this Call. */
  say(callId: string, text: string): void;
}

/** What is kept for a Call while its Caller is on the line. */
interface PhoneCall {
  readonly id: string;
  /** Settles once the line has connected, which is when the Caller can first hear anything. */
  readonly connected: Promise<void>;
  readonly connect: () => void;
}

/**
 * The rules of a Call on the phone Channel. The phone line reports what happens on it by calling the methods below,
 * and is asked to do things through `PhoneLine`.
 */
export class PhoneCalls {
  readonly #engine: FlowEngine;
  readonly #line: PhoneLine;
  /** The Calls that have arrived, by id. */
  readonly #calls = new Map<string, PhoneCall>();

  constructor(engine: FlowEngine, line: PhoneLine, _write: (text: string) => void) {
    this.#engine = engine;
    this.#line = line;
  }

  /**
   * A call arrived on the line. `callId` is the line's id for it, which becomes the Call's id. The greeting is made
   * from this moment, so that it is ready, or nearly, by the time the line connects.
   */
  callArrived(callId: string, callerNumber?: string): void {
    if (this.#calls.has(callId)) return;
    let connect!: () => void;
    const connected = new Promise<void>((resolve) => void (connect = resolve));
    const call: PhoneCall = { id: callId, connected, connect };
    this.#calls.set(callId, call);
    const number = callerNumber?.trim();
    void this.#greet(call, this.#engine.start(callId, number ? { callerNumber: number } : {}));
  }

  /** The line connected: from now on the Caller hears what the line is asked to say. */
  lineConnected(callId: string): void {
    this.#calls.get(callId)?.connect();
  }

  /** Says the greeting once it is ready and the line has connected, whichever comes later. */
  async #greet(call: PhoneCall, started: Promise<TurnResult>): Promise<void> {
    const [greeting] = await Promise.all([started, call.connected]);
    this.#line.say(call.id, greeting.reply);
  }
}
