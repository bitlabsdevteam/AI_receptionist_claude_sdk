import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, ModelClient, ModelMessage, ModelRequest, ModelResponse, ModelTool } from "./model.js";

/** Beta that turns on `fallbacks: "default"`: Anthropic retries some refusals on a fallback model, server side. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** How long to wait on one request before the SDK retries it. Voice-sized, far below the SDK's ten minutes. */
const TIMEOUT_MS = 20_000;

/** Retries for connection errors, 408, 409, 429 and 5xx, on top of the first try. */
const MAX_RETRIES = 2;

/** The same ModelClient as `FakeClaude`, but for real: Anthropic's Messages API, streamed. */
export class AnthropicModelClient implements ModelClient {
  readonly #sdk: Anthropic;

  /** Reads `ANTHROPIC_API_KEY` from the environment unless given an SDK client. */
  constructor(sdk: Anthropic = new Anthropic({ maxRetries: MAX_RETRIES, timeout: TIMEOUT_MS })) {
    this.#sdk = sdk;
  }

  async createMessage(req: ModelRequest, onTextDelta?: (delta: string) => void): Promise<ModelResponse> {
    if (req.provider !== "anthropic") {
      throw new Error(`AnthropicModelClient cannot call the "${req.provider}" provider (model "${req.model}")`);
    }

    // Everything goes through `beta` because `fallbacks` and `betas` do not exist on the plain Messages API.
    const stream = this.#sdk.beta.messages.stream({
      model: req.model,
      // Thinking counts toward max_tokens even though it is not returned.
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages.map(toMessageParam),
      ...(req.tools.length > 0
        ? { tools: req.tools.map(toToolParam), tool_choice: { type: "auto" as const } }
        : {}),
      thinking: { type: "adaptive" },
      output_config: { effort: req.effort },
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    });

    let sawText = false;
    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start" && event.content_block.type === "text") {
        if (sawText) onTextDelta?.(" ");
        sawText = true;
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        onTextDelta?.(event.delta.text);
      }
    });

    return toModelResponse(await stream.finalMessage());
  }
}

function toMessageParam(message: ModelMessage): Anthropic.Beta.BetaMessageParam {
  if (typeof message.content === "string") return { role: message.role, content: message.content };
  return {
    role: message.role,
    content: message.content.map((block): Anthropic.Beta.BetaContentBlockParam =>
      block.type === "text"
        ? { type: "text", text: block.text }
        : { type: "tool_use", id: block.id, name: block.name, input: block.input },
    ),
  };
}

function toToolParam(tool: ModelTool): Anthropic.Beta.BetaTool {
  return {
    name: tool.name,
    description: tool.description,
    strict: true,
    input_schema: { ...tool.inputSchema, type: "object" },
  };
}

function toModelResponse(message: Anthropic.Beta.BetaMessage): ModelResponse {
  const stopReason = toStopReason(message.stop_reason);
  // A refusal or the token limit can cut a tool call off mid-input, so it is never used.
  const keepToolCalls = stopReason !== "refusal" && stopReason !== "max_tokens";
  const content: ContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use" && keepToolCalls) {
      const input = typeof block.input === "object" && block.input !== null ? (block.input as Record<string, unknown>) : {};
      content.push({ type: "tool_use", id: block.id, name: block.name, input });
    }
    // Thinking, fallback and every other block type are not the Receptionist's words.
  }
  return { content, stopReason };
}

function toStopReason(reason: Anthropic.Beta.BetaStopReason | null): ModelResponse["stopReason"] {
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
      return reason;
    default:
      return "other";
  }
}
