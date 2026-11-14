import type { Flow } from "../flow/schema.js";
import type { ModelClient, ModelMessage } from "./model.js";
import { runNode } from "./run-node.js";
import { InMemorySessionStore, type Session, type SessionStore } from "./session.js";

/** A side effect for the channel adapter to perform (transfer, hang up). Reserved for later. */
export interface Action {
  type: string;
}

export interface TurnResult {
  /** Text to speak or display. */
  reply: string;
  /** The Node (or End state) the Call is at after this Turn. */
  nodeId: string;
  /** True once an End state is reached. */
  ended: boolean;
  endState?: string;
  actions: Action[];
}

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

export class FlowEngine {
  readonly #flow: Flow;
  readonly #client: ModelClient;
  readonly #store: SessionStore;

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

  #node(id: string) {
    const node = this.#flow.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Flow has no Node "${id}"`);
    return node;
  }
}
