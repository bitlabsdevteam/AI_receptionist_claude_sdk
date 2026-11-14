import type { Flow, FlowNode } from "../flow/schema.js";
import { parseModelRef, type ContentBlock, type ModelClient, type ModelMessage, type ModelResponse } from "./model.js";
import { renderTemplate } from "./templating.js";

/** Replies are spoken aloud, so they stay short. */
export const MAX_TOKENS = 300;

/** Effort when a Node does not set one. */
const DEFAULT_EFFORT = "low";

export interface RunNodeInput {
  flow: Flow;
  node: FlowNode;
  client: ModelClient;
  variables: Readonly<Record<string, string>>;
  messages: ModelMessage[];
}

export interface NodeRun {
  /** What the Receptionist says: the text blocks of the model's reply, joined. */
  text: string;
  content: ContentBlock[];
  /** Why the model stopped. `refusal` is a normal response, so the caller must check it before using `text`. */
  stopReason: ModelResponse["stopReason"];
}

/**
 * Runs one Node: one model call with the Node's rendered instructions as the system prompt.
 * Edges, business tools and end states are not handled yet, and will be layered on here.
 */
export async function runNode(input: RunNodeInput): Promise<NodeRun> {
  const { flow, node, client, variables, messages } = input;
  const { provider, model } = parseModelRef(node.model ?? flow.default_model);
  const system = [flow.base_instructions, node.instructions]
    .filter((part) => part !== "")
    .map((part) => renderTemplate(part, variables))
    .join("\n\n");

  const response = await client.createMessage({
    provider,
    model,
    system,
    messages,
    tools: [],
    effort: node.effort ?? DEFAULT_EFFORT,
    maxTokens: MAX_TOKENS,
  });

  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .trim();
  return { text, content: response.content, stopReason: response.stopReason };
}
