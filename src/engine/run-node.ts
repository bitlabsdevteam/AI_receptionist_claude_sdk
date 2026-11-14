import type { Flow, FlowEdge, FlowNode } from "../flow/schema.js";
import {
  parseModelRef,
  type ContentBlock,
  type ModelClient,
  type ModelMessage,
  type ModelResponse,
  type ModelTool,
} from "./model.js";
import { renderTemplate } from "./templating.js";

/**
 * Upper bound on one model call, not a target length. Adaptive thinking counts toward `max_tokens` even though it is
 * not returned, so the PRD's 300 can cut a reply off after a long think. Replies stay short because the Flow's
 * instructions say so (1 to 3 sentences), not because of this limit.
 */
export const MAX_TOKENS = 1024;

/** Effort when a Node does not set one. */
const DEFAULT_EFFORT = "low";

/** The name of the tool the model calls to take `edge`. */
export function transitionToolName(edge: Pick<FlowEdge, "id">): string {
  return `transition__${edge.id}`;
}

/** An Edge exposed to the model as a tool, with the Edge's condition as the description. */
function transitionTool(edge: FlowEdge): ModelTool {
  return {
    name: transitionToolName(edge),
    description: edge.condition.prompt,
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "Why this Edge applies, in a few words." } },
      required: ["reason"],
      additionalProperties: false,
    },
    strict: true,
  };
}

export interface RunNodeInput {
  flow: Flow;
  node: FlowNode;
  client: ModelClient;
  variables: Readonly<Record<string, string>>;
  messages: ModelMessage[];
  /** Edges the model may take from this Node, offered as transition tools. Defaults to none. */
  edges?: readonly FlowEdge[];
  /** What the Receptionist has already said to the Caller this Turn, so this Node does not repeat it. */
  alreadySaid?: string;
  /** Receives the model's text as it streams in. */
  onTextDelta?: (delta: string) => void;
}

export interface NodeRun {
  /** What the Receptionist says: the text blocks of the model's reply, joined. */
  text: string;
  content: ContentBlock[];
  /** Why the model stopped. `refusal` is a normal response, so the caller must check it before using `text`. */
  stopReason: ModelResponse["stopReason"];
  /** The Edge the model chose to take, if it called one of the offered transition tools. */
  edge?: FlowEdge;
}

/**
 * Runs one Node: one model call with the Node's rendered instructions as the system prompt.
 * The Node's Edges are offered as transition tools, and the one the model calls, if any, is returned as `edge`
 * (the first, if it calls several). Following the Edge is the caller's job. Business tools are not handled yet.
 */
export async function runNode(input: RunNodeInput): Promise<NodeRun> {
  const { flow, node, client, variables, messages, edges = [], alreadySaid, onTextDelta } = input;
  const { provider, model } = parseModelRef(node.model ?? flow.default_model);
  const system = [
    ...[flow.base_instructions, node.instructions]
      .filter((part) => part !== "")
      .map((part) => renderTemplate(part, variables)),
    ...(alreadySaid ? [alreadySaidNote(alreadySaid)] : []),
  ].join("\n\n");

  const response = await client.createMessage(
    {
      provider,
      model,
      system,
      messages,
      tools: edges.map(transitionTool),
      effort: node.effort ?? DEFAULT_EFFORT,
      maxTokens: MAX_TOKENS,
    },
    onTextDelta,
  );

  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .trim();
  // A refusal can truncate a tool call mid-input, so it never takes an Edge.
  const edge = response.stopReason === "refusal" ? undefined : takenEdge(response.content, edges);
  return { text, content: response.content, stopReason: response.stopReason, ...(edge ? { edge } : {}) };
}

function takenEdge(content: readonly ContentBlock[], edges: readonly FlowEdge[]): FlowEdge | undefined {
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    const edge = edges.find((e) => transitionToolName(e) === block.name);
    if (edge) return edge;
  }
  return undefined;
}

function alreadySaidNote(said: string): string {
  return `Earlier in this same turn you already said this to the Caller: "${said}". Do not repeat it or greet again. Continue from it.`;
}
