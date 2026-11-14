/** Builders for the server-sent event stream the Anthropic Messages API returns, for tests that run the real SDK offline. */

export type Json = Record<string, unknown>;

/** The wire text of a stream of events. */
export function sseBody(events: Json[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

export function sse(events: Json[]): Response {
  return new Response(sseBody(events), { status: 200, headers: { "content-type": "text/event-stream" } });
}

export const messageStart: Json = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  },
};

export function textBlock(index: number, ...deltas: string[]): Json[] {
  return [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    ...deltas.map((text) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } })),
    { type: "content_block_stop", index },
  ];
}

export function toolBlock(index: number, name: string, ...jsonParts: string[]): Json[] {
  return [
    { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${index}`, name, input: {} } },
    ...jsonParts.map((partial_json) => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } })),
    { type: "content_block_stop", index },
  ];
}

export function thinkingBlock(index: number): Json[] {
  return [
    { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index },
  ];
}

export function finish(stop_reason: string, extra: Json = {}): Json[] {
  return [
    { type: "message_delta", delta: { stop_reason, stop_sequence: null, ...extra }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}
