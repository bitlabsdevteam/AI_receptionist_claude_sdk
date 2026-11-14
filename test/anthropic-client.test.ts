import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicModelClient, FALLBACK_BETA } from "../src/engine/anthropic-client.js";
import type { ModelRequest } from "../src/engine/model.js";
import { transitionToolName } from "../src/engine/run-node.js";
import { finish, messageStart, sse, textBlock, thinkingBlock, toolBlock, type Json } from "./sse.js";

/**
 * These tests run the real SDK against a canned HTTP stream, so they check the request as it goes over the wire and the
 * SDK's own parsing of server-sent events. No network and no key. What they cannot show is how the live API behaves.
 */


interface Sent {
  url: string;
  body: Json;
  headers: Headers;
}

/** A client whose HTTP calls are answered by `respond`, recording what was sent. */
function clientWith(respond: () => Response) {
  const sent: Sent[] = [];
  const sdk = new Anthropic({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (url, init) => {
      sent.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Json,
        headers: new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]),
      });
      return respond();
    },
  });
  return { client: new AnthropicModelClient(sdk), sent };
}

const REQUEST: ModelRequest = {
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  system: "You are Ava.",
  messages: [
    { role: "user", content: "[The Call has just connected.]" },
    { role: "assistant", content: "Hello, this is Ava." },
    { role: "user", content: "I want to say goodbye." },
  ],
  tools: [
    {
      name: "transition__e_start_goodbye",
      description: "The caller wants to end the call.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
        additionalProperties: false,
      },
      strict: true,
    },
  ],
  effort: "low",
  maxTokens: 1024,
};

const plainReply = [messageStart, ...textBlock(0, "Hi"), ...finish("end_turn")];

describe("the request sent to Anthropic", () => {
  it("uses the Node's model, adaptive thinking, the Node's effort and server-side refusal fallback", async () => {
    const { client, sent } = clientWith(() => sse(plainReply));

    await client.createMessage({ ...REQUEST, effort: "medium" });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain("/v1/messages");
    expect(sent[0]!.body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 1024,
      stream: true,
      system: "You are Ava.",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      fallbacks: "default",
      tool_choice: { type: "auto" },
    });
    expect(sent[0]!.headers.get("anthropic-beta")).toContain(FALLBACK_BETA);
    expect(FALLBACK_BETA).toBe("server-side-fallback-2026-07-01");
  });

  it("sends the conversation as plain messages", async () => {
    const { client, sent } = clientWith(() => sse(plainReply));

    await client.createMessage(REQUEST);

    expect(sent[0]!.body.messages).toEqual(REQUEST.messages);
  });

  it("offers each transition tool as a strict tool", async () => {
    const { client, sent } = clientWith(() => sse(plainReply));

    await client.createMessage(REQUEST);

    expect(sent[0]!.body.tools).toEqual([
      {
        name: "transition__e_start_goodbye",
        description: "The caller wants to end the call.",
        strict: true,
        input_schema: REQUEST.tools[0]!.inputSchema,
      },
    ]);
  });

  it("sends no tools and no tool_choice when the Node offers none", async () => {
    const { client, sent } = clientWith(() => sse(plainReply));

    await client.createMessage({ ...REQUEST, tools: [] });

    expect(sent[0]!.body).not.toHaveProperty("tools");
    expect(sent[0]!.body).not.toHaveProperty("tool_choice");
  });

  it("sends none of the sampling parameters or thinking settings Sonnet 5.5 rejects", async () => {
    const { client, sent } = clientWith(() => sse(plainReply));

    await client.createMessage(REQUEST);

    const body = sent[0]!.body;
    for (const key of ["temperature", "top_p", "top_k"]) expect(body).not.toHaveProperty(key);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.tool_choice).not.toEqual({ type: "any" });
    // No assistant prefill: the last message is the Caller's.
    expect((body.messages as Json[]).at(-1)).toMatchObject({ role: "user" });
  });

  it("sends the assistant's earlier tool calls as content blocks", async () => {
    const { client, sent } = clientWith(() => sse(plainReply));

    await client.createMessage({
      ...REQUEST,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "Sure." }, { type: "tool_use", id: "t1", name: "x", input: { a: 1 } }] },
        { role: "user", content: "ok" },
      ],
    });

    expect((sent[0]!.body.messages as Json[])[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Sure." },
        { type: "tool_use", id: "t1", name: "x", input: { a: 1 } },
      ],
    });
  });

  it("refuses a model that is not on Anthropic, without calling the API", async () => {
    const { client, sent } = clientWith(() => sse(plainReply));

    await expect(client.createMessage({ ...REQUEST, provider: "openrouter", model: "acme/voice-1" })).rejects.toThrow(
      /openrouter/,
    );
    expect(sent).toHaveLength(0);
  });
});

describe("the reply from Anthropic", () => {
  it("streams text deltas in order and returns the whole text", async () => {
    const { client } = clientWith(() =>
      sse([messageStart, ...textBlock(0, "Hel", "lo ", "there."), ...finish("end_turn")]),
    );
    const deltas: string[] = [];

    const response = await client.createMessage(REQUEST, (d) => deltas.push(d));

    expect(deltas).toEqual(["Hel", "lo ", "there."]);
    expect(response).toEqual({ content: [{ type: "text", text: "Hello there." }], stopReason: "end_turn" });
  });

  it("ignores thinking blocks, and separates text blocks with a single space delta", async () => {
    const { client } = clientWith(() =>
      sse([
        messageStart,
        ...thinkingBlock(0),
        ...textBlock(1, "Sure."),
        ...toolBlock(2, "transition__e_start_goodbye", '{"reason":', '"done"}'),
        ...textBlock(3, "Bye."),
        ...finish("tool_use"),
      ]),
    );
    const deltas: string[] = [];

    const response = await client.createMessage(REQUEST, (d) => deltas.push(d));

    expect(deltas).toEqual(["Sure.", " ", "Bye."]);
    expect(response.content).toEqual([
      { type: "text", text: "Sure." },
      { type: "tool_use", id: "toolu_2", name: "transition__e_start_goodbye", input: { reason: "done" } },
      { type: "text", text: "Bye." },
    ]);
    expect(response.stopReason).toBe("tool_use");
  });

  it("works with no delta callback", async () => {
    const { client } = clientWith(() => sse(plainReply));

    await expect(client.createMessage(REQUEST)).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("maps a refusal, keeps its partial text for the caller to discard, and drops any tool call it truncated", async () => {
    const { client } = clientWith(() =>
      sse([
        messageStart,
        ...textBlock(0, "Sure, here"),
        ...toolBlock(1, "transition__e_start_goodbye", '{"rea'),
        ...finish("refusal", { stop_details: { type: "refusal", category: "cyber", explanation: null } }),
      ]),
    );
    const deltas: string[] = [];

    const response = await client.createMessage(REQUEST, (d) => deltas.push(d));

    expect(response.stopReason).toBe("refusal");
    expect(deltas.join("")).toBe("Sure, here");
    expect(response.content.some((b) => b.type === "tool_use")).toBe(false);
  });

  it("keeps a complete tool call when the reply stopped on max_tokens, so a goodbye is not lost", async () => {
    const { client } = clientWith(() =>
      sse([
        messageStart,
        ...textBlock(0, "Okay."),
        ...toolBlock(1, transitionToolName({ id: "e_start_goodbye" }), '{"reason":', '"done"}'),
        ...finish("max_tokens"),
      ]),
    );

    const response = await client.createMessage(REQUEST);

    expect(response).toEqual({
      content: [
        { type: "text", text: "Okay." },
        { type: "tool_use", id: "toolu_1", name: "transition__e_start_goodbye", input: { reason: "done" } },
      ],
      stopReason: "max_tokens",
    });
  });

  it("drops a tool call cut off mid-input by max_tokens, and still returns the rest", async () => {
    const { client } = clientWith(() =>
      sse([messageStart, ...textBlock(0, "Okay."), ...toolBlock(1, "transition__e_start_goodbye", '{"rea'), ...finish("max_tokens")]),
    );

    const response = await client.createMessage(REQUEST);

    expect(response).toEqual({ content: [{ type: "text", text: "Okay." }], stopReason: "max_tokens" });
  });

  it("drops a tool call whose input stops after a value that looks complete", async () => {
    const { client } = clientWith(() =>
      sse([messageStart, ...toolBlock(0, "transition__e_start_goodbye", '{"reason":"do'), ...finish("max_tokens")]),
    );

    const response = await client.createMessage(REQUEST);

    expect(response).toEqual({ content: [], stopReason: "max_tokens" });
  });

  it("maps any other stop reason to other", async () => {
    const { client } = clientWith(() => sse([messageStart, ...textBlock(0, "Hm."), ...finish("pause_turn")]));

    const response = await client.createMessage(REQUEST);

    expect(response.stopReason).toBe("other");
  });

  it("rejects with the SDK's error when the API says no, with nothing streamed", async () => {
    const { client } = clientWith(
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "nope" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const deltas: string[] = [];

    await expect(client.createMessage(REQUEST, (d) => deltas.push(d))).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    expect(deltas).toEqual([]);
  });
});
