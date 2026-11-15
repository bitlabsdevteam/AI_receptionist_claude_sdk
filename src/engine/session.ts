import type { TurnResult } from "./turn.js";

/** One plain-text turn of a Call's transcript. Tool calls and results are never stored here. */
export interface TranscriptEntry {
  role: "caller" | "receptionist";
  text: string;
  /**
   * Set on both sides of a Turn the model refused. The Turn stays here for display and so a repeated turn id is
   * answered the same way, but it is never shown to the model again.
   */
  refused?: true;
}

/**
 * The state of one Call. A plain serialisable object, so a store can keep it anywhere.
 * ("Session" is only the code-level name for this; the domain term is Call.)
 */
export interface Session {
  callId: string;
  currentNodeId: string;
  transcript: TranscriptEntry[];
  /** Facts that must persist across Turns. Seeded from the Flow variables. */
  variables: Record<string, string>;
  /** Result of each Turn answered so far, by turn id. A repeated turn id returns its entry instead of re-running. */
  turns: Record<string, TurnResult>;
  /** Set once the Call reaches an End state. An ended Call takes no more Turns. */
  endState?: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

export interface SessionStore {
  get(callId: string): Promise<Session | undefined>;
  put(session: Session): Promise<void>;
  delete(callId: string): Promise<void>;
}

/** Phase 1 store. Keeps copies, so it behaves like an external store that serialises sessions. */
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, Session>();

  async get(callId: string): Promise<Session | undefined> {
    const session = this.#sessions.get(callId);
    return session && structuredClone(session);
  }

  async put(session: Session): Promise<void> {
    this.#sessions.set(session.callId, structuredClone(session));
  }

  async delete(callId: string): Promise<void> {
    this.#sessions.delete(callId);
  }
}
