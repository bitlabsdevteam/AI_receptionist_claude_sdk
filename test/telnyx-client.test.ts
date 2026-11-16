import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_TELNYX_BASE_URL, speakLanguage, TelnyxClient, TelnyxError, type TelnyxClientConfig } from "../src/telnyx/client.js";

/**
 * The client is tested against canned HTTP: an injected `fetch` that records each request and answers with the next
 * scripted response. Nothing reaches Telnyx. The paths, fields and error bodies are the ones in Telnyx's API reference
 * for each command.
 */

const KEY = "KEY0123456789abcdef_TELNYX_secret";
/** The form of Telnyx's call control ids in its examples: a version, a colon, then URL-safe text. */
const CALL = "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Sent = { url: string; init: RequestInit };

/** A canned HTTP client: answers each request with the next scripted response (or throws it), and records the requests. */
function cannedFetch(...script: Array<Response | Error>) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    const next = script.shift();
    if (next === undefined) throw new Error("no canned response left");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

/** What Telnyx answers a command it accepted. */
const ok = () => Response.json({ data: { result: "ok" } });

/** What Telnyx answers a command it refuses: a list of errors, each with a code and a title. */
const refused = (status: number, ...errors: Array<Record<string, unknown>>) => Response.json({ errors }, { status });

/** An HTTP client that never answers. Like the real `fetch`, it gives up only when the request's `signal` aborts. */
const silentFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason as Error));
  })) as typeof globalThis.fetch;

/** An HTTP client that answers 500 at once and then stalls part-way through the body, until the `signal` aborts. */
const stallingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const signal = init?.signal;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"errors": [{"code": "100'));
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
  });
  return new Response(body, { status: 500 });
}) as typeof globalThis.fetch;

function client(fetch: typeof globalThis.fetch, extra: Partial<TelnyxClientConfig> = {}): TelnyxClient {
  return new TelnyxClient({ apiKey: KEY, fetch, ...extra });
}

const bodyOf = (sent: Sent): Record<string, unknown> => JSON.parse(String(sent.init.body)) as Record<string, unknown>;

async function failureOf(promise: Promise<unknown>): Promise<TelnyxError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(TelnyxError);
    return e as TelnyxError;
  }
  throw new Error("expected a TelnyxError");
}

/** Everything an error could be printed from: its message, its fields and its cause. */
function everythingIn(error: TelnyxError): string {
  const cause = error.cause as Error | undefined;
  return [error.message, error.stack, error.detail, error.code, String(cause), cause?.message, cause?.stack, JSON.stringify(error)].join("\n");
}

describe("TelnyxClient: every command", () => {
  it("is a JSON POST to the call's action, with the key in the Authorization header only", async () => {
    const { fetch, sent } = cannedFetch(ok());
    await client(fetch).answer(CALL);

    expect(sent).toHaveLength(1);
    const { url, init } = sent[0]!;
    expect(url).toBe(`https://api.telnyx.com/v2/calls/${CALL}/actions/answer`);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(url).not.toContain(KEY);
    expect(String(init.body)).not.toContain(KEY);
  });

  it("carries a command id of its own, so that Telnyx can ignore a repeat", async () => {
    const { fetch, sent } = cannedFetch(ok(), ok(), ok(), ok(), ok(), ok());
    const telnyx = client(fetch);
    await telnyx.answer(CALL);
    await telnyx.reject(CALL);
    await telnyx.hangup(CALL);
    await telnyx.speak(CALL, { text: "Goodbye.", voice: "Telnyx.Ultra.Callie" });
    await telnyx.startRelay(CALL, { url: "wss://example.com/telnyx/relay/token", voice: "Telnyx.Ultra.Callie" });
    await telnyx.stopRelay(CALL);

    const ids = sent.map((request) => bodyOf(request).command_id);
    for (const id of ids) expect(id).toMatch(UUID);
    expect(new Set(ids).size).toBe(6);
  });

  it("carries the caller's command id when given one, so that a retry is the same command", async () => {
    const { fetch, sent } = cannedFetch(ok(), ok(), ok(), ok(), ok(), ok());
    const telnyx = client(fetch);
    await telnyx.answer(CALL, { commandId: "answer:event-1" });
    await telnyx.reject(CALL, { commandId: "reject:event-1" });
    await telnyx.hangup(CALL, { commandId: "hangup:1" });
    await telnyx.speak(CALL, { text: "Goodbye.", voice: "Telnyx.Ultra.Callie", commandId: "speak:1" });
    await telnyx.startRelay(CALL, { url: "wss://example.com/r", voice: "Telnyx.Ultra.Callie", commandId: "relay:1" });
    await telnyx.stopRelay(CALL, { commandId: "stop:1" });

    expect(sent.map((request) => bodyOf(request).command_id)).toEqual([
      "answer:event-1",
      "reject:event-1",
      "hangup:1",
      "speak:1",
      "relay:1",
      "stop:1",
    ]);
  });

  it("resolves once Telnyx has accepted it", async () => {
    const { fetch } = cannedFetch(ok());
    await expect(client(fetch).hangup(CALL)).resolves.toBeUndefined();
  });

  it("keeps the call's id in the path as Telnyx gives it, and escapes what could change the path", async () => {
    const { fetch, sent } = cannedFetch(ok(), ok());
    await client(fetch).hangup("v3:abc_DEF-123");
    await client(fetch).hangup("v3:a/b?c#d e%");

    expect(sent[0]!.url).toBe("https://api.telnyx.com/v2/calls/v3:abc_DEF-123/actions/hangup");
    expect(sent[1]!.url).toBe("https://api.telnyx.com/v2/calls/v3:a%2Fb%3Fc%23d%20e%25/actions/hangup");
  });
});

describe("TelnyxClient: each command", () => {
  it("answer sends nothing but the command id", async () => {
    const { fetch, sent } = cannedFetch(ok());
    await client(fetch).answer(CALL, { commandId: "c-1" });

    expect(sent[0]!.url).toBe(`https://api.telnyx.com/v2/calls/${CALL}/actions/answer`);
    expect(bodyOf(sent[0]!)).toEqual({ command_id: "c-1" });
  });

  it("reject sends the cause Telnyx requires, a plain decline unless told otherwise", async () => {
    const { fetch, sent } = cannedFetch(ok(), ok());
    await client(fetch).reject(CALL, { commandId: "c-1" });
    await client(fetch).reject(CALL, { cause: "USER_BUSY", commandId: "c-2" });

    expect(sent[0]!.url).toBe(`https://api.telnyx.com/v2/calls/${CALL}/actions/reject`);
    expect(bodyOf(sent[0]!)).toEqual({ cause: "CALL_REJECTED", command_id: "c-1" });
    expect(bodyOf(sent[1]!)).toEqual({ cause: "USER_BUSY", command_id: "c-2" });
  });

  it("hangup sends nothing but the command id", async () => {
    const { fetch, sent } = cannedFetch(ok());
    await client(fetch).hangup(CALL, { commandId: "c-1" });

    expect(sent[0]!.url).toBe(`https://api.telnyx.com/v2/calls/${CALL}/actions/hangup`);
    expect(bodyOf(sent[0]!)).toEqual({ command_id: "c-1" });
  });

  it("speak sends the words and the voice", async () => {
    const { fetch, sent } = cannedFetch(ok());
    await client(fetch).speak(CALL, { text: "Thank you for calling. Goodbye.", voice: "Telnyx.Ultra.Callie", commandId: "c-1" });

    expect(sent[0]!.url).toBe(`https://api.telnyx.com/v2/calls/${CALL}/actions/speak`);
    expect(bodyOf(sent[0]!)).toEqual({ payload: "Thank you for calling. Goodbye.", voice: "Telnyx.Ultra.Callie", command_id: "c-1" });
  });

  it("speak sends a language only when it is one of the locales Telnyx lists for it", async () => {
    const { fetch, sent } = cannedFetch(ok(), ok(), ok());
    const telnyx = client(fetch);
    await telnyx.speak(CALL, { text: "Goodbye.", voice: "Telnyx.Ultra.Callie", language: "en-US", commandId: "c-1" });
    // The Relay takes `en`, which is what VOICE_LANGUAGE defaults to. `speak` does not list it, so it is left out.
    await telnyx.speak(CALL, { text: "Goodbye.", voice: "Telnyx.Ultra.Callie", language: "en", commandId: "c-2" });
    await telnyx.speak(CALL, { text: "Goodbye.", voice: "Telnyx.Ultra.Callie", language: "", commandId: "c-3" });

    expect(bodyOf(sent[0]!)).toEqual({ payload: "Goodbye.", voice: "Telnyx.Ultra.Callie", language: "en-US", command_id: "c-1" });
    expect(bodyOf(sent[1]!)).toEqual({ payload: "Goodbye.", voice: "Telnyx.Ultra.Callie", command_id: "c-2" });
    expect(bodyOf(sent[2]!)).toEqual({ payload: "Goodbye.", voice: "Telnyx.Ultra.Callie", command_id: "c-3" });
  });

  it("startRelay sends the address, the voice, the speech recognition engine and model, and the language", async () => {
    const { fetch, sent } = cannedFetch(Response.json({ data: { result: "ok", conversation_relay_id: "d7e9c1d4" } }));
    await client(fetch).startRelay(CALL, {
      url: "wss://example.com/telnyx/relay/a-single-use-token",
      voice: "Telnyx.Ultra.Callie",
      sttEngine: "Deepgram",
      sttModel: "deepgram/nova-3",
      language: "en",
      commandId: "c-1",
    });

    expect(sent[0]!.url).toBe(`https://api.telnyx.com/v2/calls/${CALL}/actions/conversation_relay_start`);
    expect(bodyOf(sent[0]!)).toEqual({
      url: "wss://example.com/telnyx/relay/a-single-use-token",
      voice: "Telnyx.Ultra.Callie",
      language: "en",
      transcription_engine: "Deepgram",
      transcription_engine_config: { transcription_model: "deepgram/nova-3" },
      interruptible: "speech",
      command_id: "c-1",
    });
  });

  it("startRelay always lets the Caller interrupt by speaking, and leaves what was not given to Telnyx's defaults", async () => {
    const { fetch, sent } = cannedFetch(ok(), ok());
    await client(fetch).startRelay(CALL, { url: "wss://example.com/r", voice: "Telnyx.Ultra.Callie", commandId: "c-1" });
    await client(fetch).startRelay(CALL, { url: "wss://example.com/r", voice: "Telnyx.Ultra.Callie", sttEngine: "Google", commandId: "c-2" });

    expect(bodyOf(sent[0]!)).toEqual({ url: "wss://example.com/r", voice: "Telnyx.Ultra.Callie", interruptible: "speech", command_id: "c-1" });
    expect(bodyOf(sent[1]!)).toEqual({
      url: "wss://example.com/r",
      voice: "Telnyx.Ultra.Callie",
      transcription_engine: "Google",
      interruptible: "speech",
      command_id: "c-2",
    });
  });

  it("stopRelay sends nothing but the command id", async () => {
    const { fetch, sent } = cannedFetch(ok());
    await client(fetch).stopRelay(CALL, { commandId: "c-1" });

    expect(sent[0]!.url).toBe(`https://api.telnyx.com/v2/calls/${CALL}/actions/conversation_relay_stop`);
    expect(bodyOf(sent[0]!)).toEqual({ command_id: "c-1" });
  });
});

describe("speakLanguage", () => {
  it("is the language itself when `speak` lists it, and nothing otherwise", () => {
    expect(speakLanguage("en-US")).toBe("en-US");
    expect(speakLanguage("en-GB")).toBe("en-GB");
    expect(speakLanguage("arb")).toBe("arb");
    expect(speakLanguage("en")).toBeUndefined();
    expect(speakLanguage("en-us")).toBeUndefined();
    expect(speakLanguage("")).toBeUndefined();
    expect(speakLanguage(undefined)).toBeUndefined();
  });
});

describe("TelnyxClient: the API address", () => {
  it("is api.telnyx.com unless another is given, and a slash at its end does not double", async () => {
    expect(DEFAULT_TELNYX_BASE_URL).toBe("https://api.telnyx.com");
    const { fetch, sent } = cannedFetch(ok(), ok());
    await client(fetch, { baseUrl: "http://127.0.0.1:4010" }).answer(CALL);
    await client(fetch, { baseUrl: "https://api.telnyx.eu/" }).answer(CALL);

    expect(sent[0]!.url).toBe(`http://127.0.0.1:4010/v2/calls/${CALL}/actions/answer`);
    expect(sent[1]!.url).toBe(`https://api.telnyx.eu/v2/calls/${CALL}/actions/answer`);
  });

  it("is taken from TELNYX_BASE_URL by fromEnv, with the key from TELNYX_API_KEY", async () => {
    const { fetch, sent } = cannedFetch(ok(), ok());
    await TelnyxClient.fromEnv({ TELNYX_API_KEY: KEY, TELNYX_BASE_URL: "http://localhost:4010" }, { fetch }).hangup(CALL);
    await TelnyxClient.fromEnv({ TELNYX_API_KEY: ` ${KEY} `, TELNYX_BASE_URL: "  " }, { fetch }).hangup(CALL);

    expect(sent[0]!.url).toBe(`http://localhost:4010/v2/calls/${CALL}/actions/hangup`);
    expect(new Headers(sent[0]!.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(sent[1]!.url).toBe(`https://api.telnyx.com/v2/calls/${CALL}/actions/hangup`);
    expect(new Headers(sent[1]!.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("must be https, or a stand-in on this machine, so the key is never sent in the clear", () => {
    const { fetch, sent } = cannedFetch();
    for (const baseUrl of ["http://api.telnyx.com", "http://example.com:4010", "ftp://127.0.0.1", "api.telnyx.com", "http://127.0.0.1.example.com"]) {
      expect(() => client(fetch, { baseUrl }), baseUrl).toThrow(TelnyxError);
    }
    expect(() => TelnyxClient.fromEnv({ TELNYX_API_KEY: KEY, TELNYX_BASE_URL: "http://example.com" }, { fetch })).toThrow(TelnyxError);
    expect(sent).toEqual([]);
  });

  it("is never asked anything without a key", () => {
    const { fetch, sent } = cannedFetch();
    expect(() => client(fetch, { apiKey: "" })).toThrow(new TelnyxError("TELNYX_API_KEY is not set."));
    expect(() => client(fetch, { apiKey: "   " })).toThrow(TelnyxError);
    expect(() => TelnyxClient.fromEnv({}, { fetch })).toThrow(new TelnyxError("TELNYX_API_KEY is not set."));
    expect(sent).toEqual([]);
  });
});

describe("TelnyxClient: a command that fails", () => {
  it("raises a TelnyxError with the HTTP status and Telnyx's error code", async () => {
    const { fetch } = cannedFetch(
      refused(422, { code: "90018", title: "Call has already ended", detail: "This call is no longer active and can't receive commands." }),
    );
    const error = await failureOf(client(fetch).speak(CALL, { text: "Goodbye.", voice: "Telnyx.Ultra.Callie" }));

    expect(error.name).toBe("TelnyxError");
    expect(error.command).toBe("speak");
    expect(error.status).toBe(422);
    expect(error.code).toBe("90018");
    expect(error.detail).toBe("This call is no longer active and can't receive commands.");
    expect(error.message).toBe("Telnyx refused the speak command (HTTP 422, code 90018: Call has already ended).");
  });

  it("says where a rejected field is, and takes a code that comes as a number", async () => {
    const { fetch } = cannedFetch(
      refused(422, { code: 10004, title: "Missing required parameter", detail: "The 'cause' parameter is required.", source: { pointer: "/cause" } }),
    );
    const error = await failureOf(client(fetch).reject(CALL));

    expect(error.code).toBe("10004");
    expect(error.message).toBe("Telnyx refused the reject command (HTTP 422, code 10004: Missing required parameter, at /cause).");
  });

  it("points at the key when Telnyx will not accept it", async () => {
    const { fetch } = cannedFetch(refused(401, { code: "10009", title: "Authentication failed", detail: "No key." }));
    const error = await failureOf(client(fetch).answer(CALL));

    expect(error.status).toBe(401);
    expect(error.code).toBe("10009");
    expect(error.message).toBe("Telnyx refused the answer command (HTTP 401, code 10009: Authentication failed). Check TELNYX_API_KEY.");
  });

  it("carries the status alone when the response is not Telnyx's list of errors", async () => {
    const bodies = ["<html>Bad gateway</html>", "", "null", "[]", '{"errors": "many"}', '{"errors": []}', '{"errors": [7]}'];
    for (const body of bodies) {
      const { fetch } = cannedFetch(new Response(body, { status: 502 }));
      const error = await failureOf(client(fetch).stopRelay(CALL));

      expect(error.status, body).toBe(502);
      expect(error.code, body).toBeUndefined();
      expect(error.detail, body).toBeUndefined();
      expect(error.message, body).toBe("Telnyx refused the conversation_relay_stop command (HTTP 502).");
    }
  });

  it("never repeats the response's body in its message", async () => {
    const { fetch } = cannedFetch(new Response("Internal error near wss://example.com/telnyx/relay/TOKEN", { status: 500 }));
    const error = await failureOf(client(fetch).startRelay(CALL, { url: "wss://example.com/telnyx/relay/TOKEN", voice: "Telnyx.Ultra.Callie" }));

    expect(error.message).toBe("Telnyx refused the conversation_relay_start command (HTTP 500).");
  });

  it("keeps the key out of the error, even when Telnyx's response repeats it", async () => {
    const { fetch } = cannedFetch(
      refused(401, { code: `code ${KEY}`, title: `Bad key ${KEY}`, detail: `The key ${KEY} is not valid.`, source: { pointer: `/${KEY}` } }),
    );
    const error = await failureOf(client(fetch).answer(CALL));

    expect(error.status).toBe(401);
    expect(everythingIn(error)).not.toContain(KEY);
    expect(error.detail).toBe("The key [redacted] is not valid.");
  });

  it("raises a TelnyxError without a status when Telnyx cannot be reached, and keeps the key out of it", async () => {
    const failure = Object.assign(new TypeError(`fetch failed for Bearer ${KEY}`), { headers: { authorization: `Bearer ${KEY}` } });
    const { fetch } = cannedFetch(failure);
    const error = await failureOf(client(fetch).hangup(CALL));

    expect(error.status).toBeUndefined();
    expect(error.code).toBeUndefined();
    expect(error.command).toBe("hangup");
    expect(error.message).toBe("Could not reach Telnyx for the hangup command: fetch failed for Bearer [redacted]");
    expect((error.cause as Error).name).toBe("TypeError");
    expect(everythingIn(error)).not.toContain(KEY);
  });

  it("gives up on a request that gets no response, with a TelnyxError that says how long it waited", async () => {
    const started = Date.now();
    const error = await failureOf(client(silentFetch, { timeoutMs: 40 }).answer(CALL));

    expect(Date.now() - started).toBeLessThan(2000);
    expect(error.status).toBeUndefined();
    expect(error.message).toBe("Telnyx gave no response to the answer command within 40 ms.");
    expect((error.cause as Error).name).toBe("TimeoutError");
    expect(everythingIn(error)).not.toContain(KEY);
  });

  it("gives up on an error response whose body never finishes, and still reports its status", async () => {
    const started = Date.now();
    const error = await failureOf(client(stallingFetch, { timeoutMs: 40 }).answer(CALL));

    expect(Date.now() - started).toBeLessThan(2000);
    expect(error.status).toBe(500);
    expect(error.code).toBeUndefined();
    expect(error.message).toBe("Telnyx refused the answer command (HTTP 500).");
    expect(everythingIn(error)).not.toContain(KEY);
  });

  it("sends each command once: a failure is the caller's to retry, with the same command id", async () => {
    const { fetch, sent } = cannedFetch(new Response("", { status: 500 }));
    await failureOf(client(fetch).hangup(CALL));

    expect(sent).toHaveLength(1);
  });

  it("passes a time limit to every request", async () => {
    const { fetch, sent } = cannedFetch(ok());
    await client(fetch).answer(CALL);

    expect(sent[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("the Telnyx seam", () => {
  it("imports nothing from the engine or the adapters, in any file under src/telnyx/", async () => {
    const dir = fileURLToPath(new URL("../src/telnyx/", import.meta.url));
    const files = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith(".ts"));
    expect(files).toEqual(expect.arrayContaining(["client.ts", "events.ts", "frames.ts", "signature.ts"]));

    for (const file of files) {
      const source = await readFile(join(dir, file), "utf8");
      // Every module a file names, whether after `from`, in a bare `import "..."` or in an `import("...")`.
      const imported = [...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1] ?? "");
      const outside = imported.filter((module) => /(^|\/)(engine|adapters)(\/|$)/.test(module));
      expect(outside, `engine or adapter imports in src/telnyx/${file}`).toEqual([]);
      // Stronger: a file here reaches only its neighbours and Node itself.
      for (const module of imported) {
        expect(module.startsWith("./") || module.startsWith("node:"), `src/telnyx/${file} imports ${module}`).toBe(true);
      }
    }
  });
});
