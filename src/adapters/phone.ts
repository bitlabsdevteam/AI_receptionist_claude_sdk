import type { FlowEngine } from "../engine/engine.js";
import type { TurnResult } from "../engine/turn.js";
import { messageOf } from "./chat.js";

/**
 * The fixed lines. They are the adapter's own words: they are never sent to the model, never stored in the Call's
 * transcript and never spend a turn id.
 */
export const AGAIN_LINE = "Sorry, could you say that again?";
export const TROUBLE_LINE = "Sorry, we're having technical trouble. Please call back later.";
export const TIME_LIMIT_LINE = "Sorry, I have to end this call now. Please call back if you need anything else.";

/** What the rules of a phone Call may ask of the phone line. Whatever carries the Call implements it. */
export interface PhoneLine {
  /**
   * Says `text` to the Caller on this Call. It hands the words over and returns at once, without waiting for them to
   * be spoken. Words cannot be taken back once handed over, so only a finished reply is ever passed.
   */
  say(callId: string, text: string): void;
  /**
   * Closes the Call with these words: the line stops listening, speaks `text` once, waits until it has been spoken
   * and hangs up. It returns at once. The line reports that the words were spoken by calling `closingSpoken`.
   */
  closeWith(callId: string, text: string): void;
  /** Hangs up at once, without any words. It is asked only when a closing did not finish, so it returns at once too. */
  hangUp(callId: string): void;
}

/** How long a Call may last, from the moment the call arrived. */
export const TIME_LIMIT_MS = 10 * 60 * 1000;
/** How long a closing may take, from the request to close with words, before the Call is hung up anyway. */
export const CLOSING_STALL_MS = 30_000;

export interface PhoneOptions {
  /** Reads the time in ms, for the timing line that follows each Turn. */
  clock?: () => number;
  /** Runs `run` once, `ms` from now, and returns the function that cancels it. For the time limit and a stalled closing. */
  after?: (ms: number, run: () => void) => () => void;
}

/** What is kept for a Call while its Caller is on the line. */
interface PhoneCall {
  readonly id: string;
  /** Settles once the line has connected, which is when the Caller can first hear anything. */
  readonly connected: Promise<void>;
  readonly connect: () => void;
  /** How many Turns the Call has had. The next Turn's id is the Call's id and the next number, such as `<callId>:1`. */
  turns: number;
  /** Whether the Call is being closed from our side. Nothing more is said on it and no Turn starts. */
  closing: boolean;
  /** How many Turns have failed in a row. A Turn that succeeds sets it back to 0. */
  failures: number;
  /** Cancels the time limit. */
  cancelLimit: () => void;
  /** Cancels the wait for a closing to finish, while there is one. */
  cancelStall: () => void;
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
  readonly #after: (ms: number, run: () => void) => () => void;
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
    this.#after = options.after ?? inRealTime;
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
    const call: PhoneCall = {
      id: callId,
      connected,
      connect,
      turns: 0,
      closing: false,
      failures: 0,
      cancelLimit: () => {},
      cancelStall: () => {},
      work: Promise.resolve(),
    };
    this.#calls.set(callId, call);
    call.cancelLimit = this.#after(TIME_LIMIT_MS, () => this.#close(call, TIME_LIMIT_LINE));
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
    if (!call || call.closing || utterance === "") return;
    const heard = this.#now();
    call.work = call.work.then(() => this.#turn(call, utterance, heard));
  }

  /**
   * The Caller talked over the Receptionist. It is only printed. The engine is told nothing, so the Call's transcript
   * keeps the whole reply although the Caller heard part of it, and a Turn in flight still finishes and is said.
   */
  callerInterrupted(callId: string): void {
    const call = this.#calls.get(callId);
    if (call && !call.closing) this.#write("(The Caller interrupted.)\n");
  }

  /**
   * The line's connection to us was lost while the Caller may still be there, so nothing more can be heard or said the
   * normal way. The Call is closed with the trouble line. While a Call is already being closed the loss is expected
   * and means nothing.
   */
  connectionLost(callId: string): void {
    const call = this.#calls.get(callId);
    if (!call || call.closing) return;
    this.#write("(The connection to the line was lost.)\n");
    this.#close(call, TROUBLE_LINE);
  }

  /** The line has spoken the words of a closing and hung up, so the Call is over. */
  closingSpoken(callId: string): void {
    const call = this.#calls.get(callId);
    if (!call?.closing) return;
    this.#write("The Call ended.\n");
    this.#forget(call);
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
      this.#close(call, TROUBLE_LINE);
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
      if (this.#isOver(call)) return;
      call.failures++;
      // One failed Turn is asked again. A second in a row is more than a slip, so the Call is closed.
      if (call.failures >= 2) this.#close(call, TROUBLE_LINE);
      else this.#say(call, AGAIN_LINE);
      return;
    }
    if (this.#isOver(call)) return;
    call.failures = 0;
    call.turns = turn;
    // An ending Turn's reply, the End state's message included, is the Call's last words and is not said the normal way.
    if (result.ended) {
      this.#close(call, result.reply);
      this.#write(`(Timing: reply ${Math.round(this.#now() - heard)} ms)\n`);
      return;
    }
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

  /**
   * Closes the Call from our side with these words, once: the line is asked to speak them and hang up. A Call that is
   * being closed or is over is left alone, so the first reason to close a Call is the only one.
   */
  #close(call: PhoneCall, text: string): void {
    if (this.#isOver(call)) return;
    call.closing = true;
    call.cancelLimit();
    this.#write(`Receptionist: ${text}\n`);
    try {
      this.#line.closeWith(call.id, text);
    } catch (error) {
      this.#write(`(Could not close the Call: ${messageOf(error)})\n`);
      this.#hangUp(call);
      return;
    }
    // A line that never reports the words spoken must not keep the Caller on the phone for ever.
    call.cancelStall = this.#after(CLOSING_STALL_MS, () => {
      this.#write("(The closing was not reported as spoken, hanging up.)\n");
      this.#hangUp(call);
    });
  }

  /** Hangs up now, without waiting for words, and ends the Call. */
  #hangUp(call: PhoneCall): void {
    this.#forget(call);
    try {
      this.#line.hangUp(call.id);
    } catch (error) {
      this.#write(`(Could not hang up: ${messageOf(error)})\n`);
    }
  }

  /** Whether nothing more may be said on the Call: its Caller hung up, it could not be opened, or it is being closed. */
  #isOver(call: PhoneCall): boolean {
    return call.closing || this.#calls.get(call.id) !== call;
  }

  /**
   * Ends the Call for this adapter and drops what was kept for it. Only its id is remembered, so that a late report of
   * its arrival opens nothing. A greeting still waiting for the line to connect is let go, to be said to nobody.
   */
  #forget(call: PhoneCall): void {
    call.cancelLimit();
    call.cancelStall();
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

/** Runs `run` after `ms` of real time. The timer does not keep the program alive. */
function inRealTime(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}
