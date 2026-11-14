import type { ContentBlock, ModelClient, ModelRequest, ModelResponse } from "../src/engine/model.js";

/** A scripted reply that ends the model's turn with plain text. */
export function say(text: string): ModelResponse {
  return { content: [{ type: "text", text }], stopReason: "end_turn" };
}

/** A scripted reply made of arbitrary content blocks. */
export function reply(content: ContentBlock[], stopReason: ModelResponse["stopReason"] = "end_turn"): ModelResponse {
  return { content, stopReason };
}

/**
 * Scripted stand-in for Claude. Returns the scripted responses in order and records every request.
 * Requests are cloned when recorded, because the engine may keep appending to the arrays it sent.
 */
export class FakeClaude implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly #script: ModelResponse[];

  constructor(script: readonly ModelResponse[]) {
    this.#script = [...script];
  }

  async createMessage(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(req));
    const next = this.#script.shift();
    if (next === undefined) {
      throw new Error(`FakeClaude script exhausted at request ${this.requests.length}`);
    }
    return next;
  }
}
