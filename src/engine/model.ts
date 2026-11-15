import type { FlowNode } from "../flow/schema.js";

/** Reasoning effort for the model. Always set explicitly: the API default (`high`) is too slow for voice. */
export type Effort = NonNullable<FlowNode["effort"]>;

export type ModelProvider = "anthropic" | "openrouter";

/** A tool the model may call. `inputSchema` is JSON Schema. */
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Strict schemas are how the engine steers tool use, since forced `tool_choice` is a 400 on Sonnet 5.5. */
  strict: true;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface ModelMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

/**
 * One call to a model. Deliberately has no `temperature`, `top_p` or `top_k`: non-default values are
 * rejected by Sonnet 5.5. Provider-specific options (adaptive thinking, server-side fallback, `output_config`)
 * are the real client's job to derive from these fields.
 */
export interface ModelRequest {
  provider: ModelProvider;
  /** Provider-side model id with no provider prefix, e.g. `claude-sonnet-5-5`. */
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  effort: Effort;
  maxTokens: number;
}

export interface ModelResponse {
  content: ContentBlock[];
  /** `refusal` is a normal HTTP 200 response, so callers must check it before reading `content`. */
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
}

/** Implemented by the real Anthropic and OpenRouter clients, and by `FakeClaude` in tests. */
export interface ModelClient {
  /**
   * `onTextDelta`, if given, receives the reply's text as it is generated, in order. Text blocks are separated by a
   * single space delta. It is called for the text of a response that turns out to be a refusal too, so the caller
   * decides what to show. It is never called after the returned promise settles.
   */
  createMessage(req: ModelRequest, onTextDelta?: (delta: string) => void): Promise<ModelResponse>;
}

/**
 * Splits a Flow model reference (`anthropic/<id>` or `openrouter/<vendor>/<model>`) into provider and model id.
 * The Flow schema has already validated the shape.
 */
export function parseModelRef(ref: string): { provider: ModelProvider; model: string } {
  const slash = ref.indexOf("/");
  return { provider: ref.slice(0, slash) as ModelProvider, model: ref.slice(slash + 1) };
}
