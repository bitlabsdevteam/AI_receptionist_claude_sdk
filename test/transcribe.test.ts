import { describe, expect, it } from "vitest";
import { MIN_CLIP_MS, transcribe } from "../src/voice/transcribe.js";
import { VoiceError } from "../src/voice/voice.js";
import { wavClip } from "./wav.js";

const KEY = "xi-secret-key-123";

interface Seen {
  url: string;
  init: RequestInit;
}

/** A canned HTTP layer: records each request and answers with the scripted responses, in order. */
function cannedFetch(...responses: Array<Response | Error>) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    seen.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("no canned response left");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const options = (fetch: typeof globalThis.fetch) => ({ apiKey: KEY, modelId: "scribe_v2", fetch });
const oneSecond = wavClip(1000);

describe("transcribe: request shape", () => {
  it("posts the clip as multipart to the speech-to-text endpoint with the key and model", async () => {
    const { fetch, seen } = cannedFetch(json({ text: "hello" }));
    await transcribe(options(fetch), oneSecond);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(seen[0]!.init.method).toBe("POST");
    const headers = new Headers(seen[0]!.init.headers);
    expect(headers.get("xi-api-key")).toBe(KEY);
    // fetch must set the multipart boundary itself.
    expect(headers.has("content-type")).toBe(false);
    const form = seen[0]!.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model_id")).toBe("scribe_v2");
    expect((form.get("file") as File).size).toBe(oneSecond.byteLength);
  });
});

describe("transcribe: response parsing", () => {
  it("returns the transcript, trimmed", async () => {
    const { fetch } = cannedFetch(json({ text: "  Hi, I need to book an appointment.  \n", words: [] }));
    expect(await transcribe(options(fetch), oneSecond)).toBe("Hi, I need to book an appointment.");
  });

  it.each([
    ["an empty text", { text: "" }],
    ["a blank text", { text: "   " }],
    ["no text field", { language_code: "eng" }],
    ["a non-string text", { text: null }],
  ])("returns an empty transcript for %s, without inventing words", async (_name, body) => {
    const { fetch } = cannedFetch(json(body));
    expect(await transcribe(options(fetch), oneSecond)).toBe("");
  });

  it("fails with a VoiceError when the body is not JSON", async () => {
    const { fetch } = cannedFetch(new Response("<html>oops</html>", { status: 200 }));
    await expect(transcribe(options(fetch), oneSecond)).rejects.toBeInstanceOf(VoiceError);
  });
});

describe("transcribe: errors", () => {
  it.each([
    [401, /key/i],
    [429, /rate|busy|limit/i],
    [500, /unavailable|server/i],
    [418, /418/],
  ])("maps HTTP %i to a VoiceError", async (status, message) => {
    const { fetch } = cannedFetch(json({ detail: { status: "whatever" } }, status));
    const error = await transcribe(options(fetch), oneSecond).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceError);
    expect((error as Error).message).toMatch(message);
  });

  it("maps a network failure to a VoiceError", async () => {
    const { fetch } = cannedFetch(new TypeError("fetch failed"));
    const error = await transcribe(options(fetch), oneSecond).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceError);
    expect((error as Error).message).toMatch(/fetch failed/);
  });

  it("never puts the API key in an error message, even when a lower layer echoes it", async () => {
    const echoing = [new TypeError(`bad header xi-api-key: ${KEY}`), json({ detail: `invalid key ${KEY}` }, 401)];
    for (const failure of echoing) {
      const { fetch } = cannedFetch(failure);
      const error = (await transcribe(options(fetch), oneSecond).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(VoiceError);
      expect(error.message).not.toContain(KEY);
    }
  });
});

describe("transcribe: clips too short to hear", () => {
  it("treats a clip under 100 ms as nothing heard, without calling the API", async () => {
    const { fetch, seen } = cannedFetch();
    expect(MIN_CLIP_MS).toBe(100);
    expect(await transcribe(options(fetch), wavClip(99))).toBe("");
    expect(await transcribe(options(fetch), new Uint8Array(0))).toBe("");
    expect(seen).toHaveLength(0);
  });

  it("sends a clip of exactly 100 ms", async () => {
    const { fetch, seen } = cannedFetch(json({ text: "ok" }));
    expect(await transcribe(options(fetch), wavClip(100))).toBe("ok");
    expect(seen).toHaveLength(1);
  });
});
