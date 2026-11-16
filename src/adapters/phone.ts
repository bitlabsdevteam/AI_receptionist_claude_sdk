import type { FlowEngine } from "../engine/engine.js";
import type { TurnResult } from "../engine/turn.js";
import { messageOf } from "./chat.js";

/** What the rules of a phone Call may ask of the phone line. Whatever carries the Call implements it. */
export interface PhoneLine {
  /**
   * Says `text` to the Caller on this Call. It hands the words over and returns at once, without waiting for them to
   * be spoken. Words cannot be taken back once handed over, so only a finished reply is ever passed.
   */
  say(callId: string, text: string): void;
}

export interface PhoneOptions {
  /** Reads the time in ms, for the timing line that follows each Turn. */
  clock?: () => number;
}

/** What is kept for a Call while its Caller is on the line. */
interface PhoneCall {
  readonly id: string;
  /** Settles once the line has connected, which is when the Caller can first hear anything. */
  readonly connected: Promise<void>;
  readonly connect: () => void;
  /** How many Turns the Call has had. The next Turn's id is the Call's id and the next number, such as `<callId>:1`. */
  turns: number;
  /**
   * The Call's work so far, one piece after another: the greeting, then each Turn. Whatever the Caller says next is
   * added to its end, so a Turn starts only when the greeting and every earlier Turn have been said. It never rejects.
   */
  work: Promise<void>;
}

/**
 * The rules of a Call on the phone Channel, for every Call on the line at once. It knows the line only as things that
 * happen on it, which are reported by calling the five methods below (a call arrived, the line connected, the Caller
 * said something, interrupted or hung up), and as `PhoneLine`, through which it asks for words to be said.
 *
 * Each method returns at once and never throws. The work it starts goes on behind it, one piece at a time for each
 * Call, and Calls do not wait for each other. A report about a Call that never arrived, or that is over, is ignored.
 */
export class PhoneCalls {
  readonly #engine: FlowEngine;
  readonly #line: PhoneLine;
  readonly #write: (text: string) => void;
  readonly #now: () => number;
  /** The Calls whose Callers are on the line, by id. */
  readonly #calls = new Map<string, PhoneCall>();
  /** The ids of the Calls that are over. Whatever the line still reports for one of them is ignored. */
  readonly #over = new Set<string>();

  /** `write` prints a line for whoever is at the terminal. It is plain output, not a Trace. */
  constructor(engine: FlowEngine, line: PhoneLine, write: (text: string) => void, options: PhoneOptions = {}) {
    this.#engine = engine;
    this.#line = line;
    this.#write = write;
    this.#now = options.clock ?? (() => performance.now());
  }

  /**
   * A call arrived on the line. `callId` is the line's id for it, which becomes the Call's id, and `callerNumber` is
   * left out when the Caller withheld it. The greeting is made from this moment, so that it is ready, or nearly, by
   * the time the line connects. An arrival reported again opens nothing more.
   */
  callArrived(callId: string, callerNumber?: string): void {
    if (this.#calls.has(callId) || this.#over.has(callId)) return;
    let connect!: () => void;
    const connected = new Promise<void>((resolve) => void (connect = resolve));
    const number = callerNumber?.trim();
    const call: PhoneCall = { id: callId, connected, connect, turns: 0, work: Promise.resolve() };
    this.#calls.set(callId, call);
    this.#write(`Call arrived from ${shownNumber(number)}.\n`);
    call.work = this.#greet(call, this.#engine.start(callId, number ? { callerNumber: number } : {}));
  }

  /** The line connected: from now on the Caller hears what the line is asked to say. */
  lineConnected(callId: string): void {
    this.#calls.get(callId)?.connect();
  }

  /** The Caller finished saying something, which the line heard as `text`. */
  callerSaid(callId: string, text: string): void {
    const call = this.#calls.get(callId);
    const utterance = text.trim();
    // Nothing heard is not a Turn: it reaches nothing and spends no turn id.
    if (!call || utterance === "") return;
    const heard = this.#now();
    call.work = call.work.then(() => this.#turn(call, utterance, heard));
  }

  /**
   * The Caller talked over the Receptionist. It is only printed. The engine is told nothing, so the Call's transcript
   * keeps the whole reply although the Caller heard part of it, and a Turn in flight still finishes and is said.
   */
  callerInterrupted(callId: string): void {
    if (this.#calls.has(callId)) this.#write("(The Caller interrupted.)\n");
  }

  /**
   * The Caller hung up, so the Call is over. A Turn in flight is left to finish in the engine, since nothing can
   * cancel it, but its reply is said to nobody and no Turn starts after it.
   */
  callerHungUp(callId: string): void {
    const call = this.#calls.get(callId);
    if (!call) return;
    this.#write("The Caller hung up.\n");
    this.#forget(call);
  }

  /** Says the greeting once it is ready and the line has connected, whichever comes later. */
  async #greet(call: PhoneCall, started: Promise<TurnResult>): Promise<void> {
    let greeting: TurnResult;
    try {
      [greeting] = await Promise.all([started, call.connected]);
    } catch (error) {
      this.#write(`Could not open the Call: ${messageOf(error)}\n`);
      this.#forget(call);
      return;
    }
    if (this.#isOver(call)) return;
    this.#say(call, greeting.reply);
  }

  /**
   * Runs one Turn and says its reply. `heard` is when the utterance arrived, which may be well before the Turn starts:
   * the timing line counts the wait behind the greeting or an earlier Turn, because the Caller waits through it too.
   * A Turn that fails was not recorded by the engine, so it spends no turn id.
   */
  async #turn(call: PhoneCall, utterance: string, heard: number): Promise<void> {
    if (this.#isOver(call)) return;
    this.#write(`Caller: ${utterance}\n`);
    const turn = call.turns + 1;
    let result: TurnResult;
    try {
      result = await this.#engine.handleUser(call.id, utterance, `${call.id}:${turn}`);
    } catch (error) {
      this.#write(`(The Receptionist could not answer: ${messageOf(error)})\n`);
      return;
    }
    if (this.#isOver(call)) return;
    call.turns = turn;
    if (this.#say(call, result.reply)) this.#write(`(Timing: reply ${Math.round(this.#now() - heard)} ms)\n`);
  }

  /**
   * Prints the Receptionist's words, the greeting or a finished Turn's reply, and hands them to the line. A line that
   * cannot take them costs one printed line and nothing else: the Turn stands and the Call carries on. Returns whether
   * the line took them.
   */
  #say(call: PhoneCall, text: string): boolean {
    this.#write(`Receptionist: ${text}\n`);
    try {
      this.#line.say(call.id, text);
      return true;
    } catch (error) {
      this.#write(`(Could not say the reply: ${messageOf(error)})\n`);
      return false;
    }
  }

  /** Whether the Call is over: its Caller hung up, or it could not be opened. */
  #isOver(call: PhoneCall): boolean {
    return this.#calls.get(call.id) !== call;
  }

  /**
   * Ends the Call for this adapter and drops what was kept for it. Only its id is remembered, so that a late report of
   * its arrival opens nothing. A greeting still waiting for the line to connect is let go, to be said to nobody.
   */
  #forget(call: PhoneCall): void {
    this.#calls.delete(call.id);
    this.#over.add(call.id);
    call.connect();
  }
}

/**
 * How a Caller's number is printed: by its last four digits, never whole. No number is a withheld one. A number of
 * four digits or fewer would be whole in its last four, so none of it is shown.
 */
function shownNumber(number: string | undefined): string {
  if (!number) return "a withheld number";
  const digits = number.replace(/\D/g, "");
  return digits.length > 4 ? `a number ending ${digits.slice(-4)}` : "a short number";
}
