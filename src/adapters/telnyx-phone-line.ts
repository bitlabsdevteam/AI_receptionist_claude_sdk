import type { WebSocket } from "ws";
import { messageOf } from "./chat.js";
import type { PhoneLine } from "./phone.js";
import type { TelnyxClient } from "../telnyx/client.js";
import { textFrame } from "../telnyx/frames.js";

/** What a Call on this line is made of: Telnyx's id to address commands to, the Relay connection once it has joined. */
interface LineCall {
  readonly callControlId: string;
  socket: WebSocket | undefined;
  /** Set when the rules asked to close the Call with words. After that the line waits for the words to be spoken. */
  closing: boolean;
}

/** What became of a report that speech ended. */
export type SpeechEndedOutcome = "not-closing" | "hung-up" | "hang-up-failed";

/**
 * The phone line for the rules of a phone Call (`PhoneLine`), carried by Telnyx: a reply is one `text` frame on the
 * Call's Relay connection, and a closing is the Relay stopped, the words spoken with Call Control `speak`, and, once
 * Telnyx says they were spoken, a hang-up. It holds only what it needs to address a Call, and says nothing about the
 * Call's rules.
 *
 * `PhoneLine` methods return at once: the commands they send go on behind them, and one that fails is printed through
 * `write`, never thrown. A failed `speak` hangs up straight away, since nothing more can be said.
 */
export class TelnyxPhoneLine implements PhoneLine {
  readonly #client: TelnyxClient;
  readonly #voice: string;
  readonly #language: string;
  readonly #write: (text: string) => void;
  readonly #calls = new Map<string, LineCall>();

  /** `voice` and `language` are the Call's settings. `write` prints a line for whoever is at the terminal. */
  constructor(client: TelnyxClient, settings: { voice: string; language: string }, write: (text: string) => void) {
    this.#client = client;
    this.#voice = settings.voice;
    this.#language = settings.language;
    this.#write = write;
  }

  /** A call arrived: from now on `callId` can be addressed. */
  open(callId: string, callControlId: string): void {
    this.#calls.set(callId, { callControlId, socket: undefined, closing: false });
  }

  has(callId: string): boolean {
    return this.#calls.has(callId);
  }

  /** Telnyx's id of the call leg, or undefined for a Call that is not on the line. */
  callControlIdOf(callId: string): string | undefined {
    return this.#calls.get(callId)?.callControlId;
  }

  /** The ids of the Calls on the line, which are the ones that were not over. */
  calls(): string[] {
    return [...this.#calls.keys()];
  }

  /** Whether the Call has joined its Relay connection, so it can be told things. */
  hasRelay(callId: string): boolean {
    return this.#calls.get(callId)?.socket !== undefined;
  }

  /** The Call's Relay connection has joined. */
  attach(callId: string, socket: WebSocket): void {
    const call = this.#calls.get(callId);
    if (call) call.socket = socket;
  }

  /** The Call is over: nothing more can be sent on it. Its Relay connection is closed if it is still open. */
  close(callId: string): void {
    const call = this.#calls.get(callId);
    this.#calls.delete(callId);
    const socket = call?.socket;
    if (socket && socket.readyState <= 1) socket.close(1000);
  }

  say(callId: string, text: string): void {
    const socket = this.#calls.get(callId)?.socket;
    if (!socket || socket.readyState !== 1) throw new Error("the Relay connection is not open");
    socket.send(textFrame(text));
  }

  closeWith(callId: string, text: string): void {
    const call = this.#calls.get(callId);
    if (!call) throw new Error("the Call is not on the line");
    call.closing = true;
    void this.#speakAndWait(call, text);
  }

  hangUp(callId: string): void {
    const call = this.#calls.get(callId);
    if (!call) return;
    void this.#hangup(call);
  }

  /**
   * Telnyx says speech on the Call has ended. If the line was waiting for its closing words, it hangs up and says so;
   * a hang-up that fails is left to the rules, which ask again when the closing stalls. `status` `call_hangup` means
   * the Caller hung up while the words were spoken, so there is nothing left to hang up.
   */
  async speechEnded(callId: string, status: string | undefined): Promise<SpeechEndedOutcome> {
    const call = this.#calls.get(callId);
    if (!call?.closing) return "not-closing";
    if (status === "call_hangup") return "hung-up";
    return (await this.#hangup(call)) ? "hung-up" : "hang-up-failed";
  }

  async #speakAndWait(call: LineCall, text: string): Promise<void> {
    try {
      await this.#client.stopRelay(call.callControlId);
    } catch (error) {
      // A Relay that could not be stopped may be gone already. The words are still worth speaking.
      this.#write(`(Could not stop the Relay: ${messageOf(error)})\n`);
    }
    try {
      await this.#client.speak(call.callControlId, { text, voice: this.#voice, language: this.#language });
    } catch (error) {
      this.#write(`(Could not speak the closing words: ${messageOf(error)})\n`);
      await this.#hangup(call);
    }
  }

  async #hangup(call: LineCall): Promise<boolean> {
    try {
      await this.#client.hangup(call.callControlId);
      return true;
    } catch (error) {
      this.#write(`(Could not hang up: ${messageOf(error)})\n`);
      return false;
    }
  }
}
