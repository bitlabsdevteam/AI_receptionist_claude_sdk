import type { ContentBlock, ModelClient, ModelRequest, ModelResponse } from "../src/engine/model.js";
import { transitionToolName } from "../src/engine/run-node.js";
import { parseFlow, type Flow } from "../src/flow/schema.js";

/** What the sample Flow's start Node greets with, as the scripted model says it. */
export const GREETING = "Hello, this is Ava from Acme Co. How can I help you today?";

/** The sample Flow's `goodbye` End state message. */
export const GOODBYE_MESSAGE = "Thank you for calling. Goodbye.";

/** A scripted reply that ends the model's turn with plain text. */
export function say(text: string): ModelResponse {
  return { content: [{ type: "text", text }], stopReason: "end_turn" };
}

/** A scripted reply made of arbitrary content blocks. */
export function reply(content: ContentBlock[], stopReason: ModelResponse["stopReason"] = "end_turn"): ModelResponse {
  return { content, stopReason };
}

/** A scripted reply that calls an Edge's transition tool, optionally with text before it. */
export function transition(edgeId: string, text?: string): ModelResponse {
  const content: ContentBlock[] = [
    ...(text ? [{ type: "text" as const, text }] : []),
    { type: "tool_use", id: `toolu_${edgeId}`, name: transitionToolName({ id: edgeId }), input: { reason: "the caller said so" } },
  ];
  return reply(content, "tool_use");
}

/** A scripted reply that takes the sample Flow's goodbye Edge. */
export function goodbye(text?: string): ModelResponse {
  return transition("e_start_goodbye", text);
}

/** The sample Flow plus a `billing` Node, to exercise Edges between Nodes. Only the goodbye Edge ships in the sample. */
export function flowWithBilling(flow: Flow, extraEdges: Flow["edges"] = []): Flow {
  return parseFlow({
    ...structuredClone(flow),
    nodes: [
      ...structuredClone(flow.nodes),
      {
        id: "billing",
        type: "prompt",
        effort: "medium",
        model: "anthropic/claude-haiku-5",
        instructions: "You now help with billing questions for {{company_name}}.",
      },
    ],
    edges: [
      ...structuredClone(flow.edges),
      {
        id: "e_start_billing",
        from: "start",
        to: "billing",
        condition: { type: "llm", prompt: "The caller asks about an invoice or payment." },
      },
      ...extraEdges,
    ],
  });
}

/** A scripted request that streams `text` and then fails, like a connection lost mid-reply. */
export interface ScriptedFailure {
  text: string;
  error: Error;
}

export function failAfter(text: string, error: Error): ScriptedFailure {
  return { text, error };
}

/** Splits text into word-sized deltas that concatenate back to the original, whitespace included. */
function wordDeltas(text: string): string[] {
  return text.match(/\s*\S+\s*|\s+/g) ?? [];
}

/**
 * Scripted stand-in for Claude. Returns the scripted responses in order and records every request.
 * Requests are cloned when recorded, because the engine may keep appending to the arrays it sent.
 *
 * Like the real client it streams: every text block is delivered to `onTextDelta` word by word before the
 * response resolves, with a single space between blocks. That includes the text of a refused response.
 */
export class FakeClaude implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly #script: (ModelResponse | ScriptedFailure)[];

  constructor(script: readonly (ModelResponse | ScriptedFailure)[]) {
    this.#script = [...script];
  }

  async createMessage(req: ModelRequest, onTextDelta?: (delta: string) => void): Promise<ModelResponse> {
    this.requests.push(structuredClone(req));
    const next = this.#script.shift();
    if (next === undefined) {
      throw new Error(`FakeClaude script exhausted at request ${this.requests.length}`);
    }
    if ("error" in next) {
      for (const delta of wordDeltas(next.text)) onTextDelta?.(delta);
      throw next.error;
    }
    let first = true;
    for (const block of next.content) {
      if (block.type !== "text") continue;
      if (!first) onTextDelta?.(" ");
      first = false;
      for (const delta of wordDeltas(block.text)) onTextDelta?.(delta);
    }
    return next;
  }
}
