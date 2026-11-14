import type { Flow } from "../flow/schema.js";
import type { ModelClient, ModelMessage } from "./model.js";
import { runNode } from "./run-node.js";
import { InMemorySessionStore, type Session, type SessionStore, type TranscriptEntry } from "./session.js";
import { renderTemplate } from "./templating.js";
import type { TurnResult } from "./turn.js";

/** Spoken when the model produced nothing to say. */
export const EMPTY_REPLY_LINE = "Sorry, could you say that again?";

/** Spoken when the model refused to answer. Says nothing about why, and offers nothing the Receptionist cannot do. */
export const REFUSAL_LINE = "I'm sorry, I can't help with that. Is there anything else I can help you with?";

export interface StartContext {
  callerNumber?: string;
}

/** Most Nodes that run for one Caller utterance, which guards against routing loops. */
export const DEFAULT_MAX_HOPS = 4;

export interface FlowEngineOptions {
  client: ModelClient;
  store?: SessionStore;
  /** Most Nodes that run for one Caller utterance. Defaults to `DEFAULT_MAX_HOPS`. */
  maxHops?: number;
}

/** Where one utterance left the Call. `endState` is set when the Call ended, and `nodeId` is the last Node that ran. */
interface Advance {
  reply: string;
  nodeId: string;
  endState?: string;
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
  readonly #maxHops: number;
  /** Tail of the queue of Turns in flight for each Call, so Turns on one Call run one at a time. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(flow: Flow, options: FlowEngineOptions) {
    this.#flow = flow;
    this.#client = options.client;
    this.#store = options.store ?? new InMemorySessionStore();
    const maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
    if (!Number.isInteger(maxHops) || maxHops < 1) throw new Error(`maxHops must be a positive integer, got ${maxHops}`);
    this.#maxHops = maxHops;
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

    const outcome = await this.#advance(session, utterance);
    const result: TurnResult = {
      reply: outcome.reply,
      nodeId: outcome.endState ?? outcome.nodeId,
      ended: outcome.endState !== undefined,
      ...(outcome.endState !== undefined ? { endState: outcome.endState } : {}),
      actions: [],
    };
    session.currentNodeId = outcome.nodeId;
    if (outcome.endState !== undefined) session.endState = outcome.endState;
    session.transcript.push({ role: "caller", text: utterance }, { role: "receptionist", text: outcome.reply });
    session.turns[turnId] = result;
    session.updatedAt = Date.now();
    await this.#store.put(session);
    return result;
  }

  /**
   * Runs the Caller's utterance through the Flow. Each hop runs one Node on the same utterance. If the model takes an
   * Edge to another Node, that Node runs next, told what has already been said. An Edge to an End state finishes the
   * Call: the End state's message is spoken after anything said so far, even if nothing was. At most `maxHops` Nodes
   * run per utterance, so a routing loop stops on the Node it reached. Does not change the session.
   */
  async #advance(session: Session, utterance: string): Promise<Advance> {
    const history: ModelMessage[] = [...modelHistory(session.transcript), { role: "user", content: utterance }];
    const said: string[] = [];
    let node = this.#node(session.currentNodeId);

    for (let hop = 1; ; hop++) {
      const run = await runNode({
        flow: this.#flow,
        node,
        client: this.#client,
        variables: session.variables,
        messages: [...history],
        edges: this.#flow.edges.filter((edge) => edge.from === node.id),
        ...(said.length > 0 ? { alreadySaid: said.join(" ") } : {}),
      });

      // A refusal discards the whole Turn, so the Call stays where it was and nothing half-said is spoken.
      if (run.stopReason === "refusal") return { reply: REFUSAL_LINE, nodeId: session.currentNodeId };
      if (run.text) said.push(run.text);

      const edge = run.edge;
      if (!edge) break;
      const endState = this.#flow.end_states[edge.to];
      if (endState) {
        const message = renderTemplate(endState.message, session.variables);
        return { reply: [...said, message].join(" "), nodeId: node.id, endState: edge.to };
      }
      if (hop >= this.#maxHops) break;
      node = this.#node(edge.to);
    }
    return { reply: said.join(" ") || EMPTY_REPLY_LINE, nodeId: node.id };
  }

  #node(id: string) {
    const node = this.#flow.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Flow has no Node "${id}"`);
    return node;
  }
}
