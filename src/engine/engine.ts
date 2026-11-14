import type { Flow } from "../flow/schema.js";
import type { ModelClient, ModelMessage } from "./model.js";
import { runNode } from "./run-node.js";
import { InMemorySessionStore, type Session, type SessionStore, type TranscriptEntry } from "./session.js";
import type { TurnResult } from "./turn.js";

/** Spoken when the model produced nothing to say. */
export const EMPTY_REPLY_LINE = "Sorry, could you say that again?";

/** Spoken when the model refused to answer. Says nothing about why, and offers nothing the Receptionist cannot do. */
export const REFUSAL_LINE = "I'm sorry, I can't help with that. Is there anything else I can help you with?";

export interface StartContext {
  callerNumber?: string;
}

export interface FlowEngineOptions {
  client: ModelClient;
  store?: SessionStore;
}

/**
 * The model API needs a user message first, and nobody has spoken when a Call opens.
 * This stand-in is sent to the model but never stored in the transcript.
 */
const CALL_CONNECTED = "[The Call has just connected. The Caller has not said anything yet.]";

/**
 * The Call so far as model messages. The model API needs a user message first, and the Receptionist speaks first,
 * so the transcript is preceded by the same stand-in `start` used.
 */
function modelHistory(transcript: readonly TranscriptEntry[]): ModelMessage[] {
  return [
    { role: "user", content: CALL_CONNECTED },
    ...transcript.map((entry): ModelMessage => ({
      role: entry.role === "caller" ? "user" : "assistant",
      content: entry.text,
    })),
  ];
}

export class FlowEngine {
  readonly #flow: Flow;
  readonly #client: ModelClient;
  readonly #store: SessionStore;
  /** Tail of the queue of Turns in flight for each Call, so Turns on one Call run one at a time. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(flow: Flow, options: FlowEngineOptions) {
    this.#flow = flow;
    this.#client = options.client;
    this.#store = options.store ?? new InMemorySessionStore();
  }

  /** Opens a Call: runs the start Node with no Caller input and returns the Receptionist's greeting. */
  async start(callId: string, ctx: StartContext): Promise<TurnResult> {
    if (await this.#store.get(callId)) throw new Error(`Call "${callId}" is already open`);
    const node = this.#node(this.#flow.start_node);
    const now = Date.now();
    const session: Session = {
      callId,
      currentNodeId: node.id,
      transcript: [],
      variables: { ...this.#flow.variables, ...(ctx.callerNumber ? { caller_number: ctx.callerNumber } : {}) },
      turns: {},
      createdAt: now,
      updatedAt: now,
    };

    const messages: ModelMessage[] = [{ role: "user", content: CALL_CONNECTED }];
    const run = await runNode({
      flow: this.#flow,
      node,
      client: this.#client,
      variables: session.variables,
      messages,
    });

    session.transcript.push({ role: "receptionist", text: run.text });
    await this.#store.put(session);
    return { reply: run.text, nodeId: session.currentNodeId, ended: false, actions: [] };
  }

  /**
   * Answers one Caller utterance from the Call's current Node. Idempotent on `turnId`: repeating a Turn returns its
   * stored result without calling the model or touching the transcript. Turns on one Call run one at a time.
   */
  handleUser(callId: string, utterance: string, turnId: string): Promise<TurnResult> {
    const run = (this.#queues.get(callId) ?? Promise.resolve()).then(() => this.#turn(callId, utterance, turnId));
    const tail = run.catch(() => undefined);
    this.#queues.set(callId, tail);
    void tail.then(() => {
      if (this.#queues.get(callId) === tail) this.#queues.delete(callId);
    });
    return run;
  }

  async #turn(callId: string, utterance: string, turnId: string): Promise<TurnResult> {
    const session = await this.#store.get(callId);
    if (!session) throw new Error(`Call "${callId}" does not exist`);
    const stored = session.turns[turnId];
    if (stored) return stored;
    if (session.endState !== undefined) throw new Error(`Call "${callId}" has ended (${session.endState})`);

    const run = await runNode({
      flow: this.#flow,
      node: this.#node(session.currentNodeId),
      client: this.#client,
      variables: session.variables,
      messages: [...modelHistory(session.transcript), { role: "user", content: utterance }],
    });

    const reply = run.stopReason === "refusal" ? REFUSAL_LINE : run.text || EMPTY_REPLY_LINE;
    const result: TurnResult = { reply, nodeId: session.currentNodeId, ended: false, actions: [] };
    session.transcript.push({ role: "caller", text: utterance }, { role: "receptionist", text: reply });
    session.turns[turnId] = result;
    session.updatedAt = Date.now();
    await this.#store.put(session);
    return result;
  }

  #node(id: string) {
    const node = this.#flow.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Flow has no Node "${id}"`);
    return node;
  }
}
