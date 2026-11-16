import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, ElevenLabsVoice } from "../src/voice/elevenlabs.js";
import type { Player } from "../src/voice/player.js";
import { VoiceError } from "../src/voice/voice.js";

const KEY = "sk_test_SECRET_KEY_123";
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4]);

type Call = { url: string; init: RequestInit };

/** A canned HTTP client: answers each request with the next scripted response (or throws it), and records the requests. */
function cannedFetch(...script: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = script.shift();
    if (next === undefined) throw new Error("no canned response left");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const audio = () => new Response(MP3, { status: 200, headers: { "content-type": "audio/mpeg" } });

/** A stand-in player: records the file it was given and the bytes in it at that moment. Plays nothing. */
function recordingPlayer(fail?: Error) {
  const played: Array<{ path: string; bytes: Uint8Array }> = [];
  const player: Player = async (path) => {
    played.push({ path, bytes: new Uint8Array(readFileSync(path)) });
    if (fail) throw fail;
  };
  return { player, played };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "elevenlabs-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function voice(fetch: typeof globalThis.fetch, player: Player, extra: Partial<ConstructorParameters<typeof ElevenLabsVoice>[0]> = {}) {
  return new ElevenLabsVoice({ apiKey: KEY, voiceId: "voice/1", fetch, player, tmpDir: dir, ...extra });
}

async function failureOf(promise: Promise<unknown>): Promise<VoiceError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(VoiceError);
    return e as VoiceError;
  }
  throw new Error("expected a VoiceError");
}

describe("ElevenLabsVoice.speak", () => {
  it("posts the text to the text-to-speech endpoint with the key in the header only", async () => {
    const { fetch, calls } = cannedFetch(audio());
    const { player } = recordingPlayer();
    await voice(fetch, player).speak("Hello, this is Sam.");

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice%2F1?output_format=mp3_44100_128");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("xi-api-key")).toBe(KEY);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ text: "Hello, this is Sam.", model_id: DEFAULT_MODEL_ID });
    expect(url).not.toContain(KEY);
    expect(String(init.body)).not.toContain(KEY);
  });

  it("defaults to a low-latency model and lets the model be overridden", async () => {
    expect(DEFAULT_MODEL_ID).toBe("eleven_flash_v2_5");
    const { fetch, calls } = cannedFetch(audio());
    await voice(fetch, recordingPlayer().player, { modelId: "eleven_v4_turbo" }).speak("Hi");
    expect(JSON.parse(String(calls[0]!.init.body)).model_id).toBe("eleven_v4_turbo");
  });

  it("hands the mp3 bytes to the player as a file, then deletes the file", async () => {
    const { fetch } = cannedFetch(audio());
    const { player, played } = recordingPlayer();
    await voice(fetch, player).speak("Hi");

    expect(played).toHaveLength(1);
    expect(played[0]!.path.startsWith(dir)).toBe(true);
    expect(played[0]!.path.endsWith(".mp3")).toBe(true);
    expect([...played[0]!.bytes]).toEqual([...MP3]);
    expect(existsSync(played[0]!.path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("deletes the file when the player fails, and reports a VoiceError", async () => {
    const { fetch } = cannedFetch(audio());
    const { player, played } = recordingPlayer(new Error("afplay exited with code 1"));
    const error = await failureOf(voice(fetch, player).speak("Hi"));

    expect(error.message).toMatch(/play/i);
    expect(existsSync(played[0]!.path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("says nothing and makes no request for blank text", async () => {
    const { fetch, calls } = cannedFetch();
    const { player, played } = recordingPlayer();
    await voice(fetch, player).speak("   ");
    expect(calls).toHaveLength(0);
    expect(played).toHaveLength(0);
  });

  it.each([
    [401, /key/i],
    [403, /key/i],
    [429, /rate limit|quota/i],
    [500, /service/i],
    [503, /service/i],
    [404, /service/i],
    [422, /service/i],
  ])("maps HTTP %i to a VoiceError without the key and plays nothing", async (status, pattern) => {
    // The body deliberately echoes the key and is not JSON: the mapping must not depend on a body shape.
    const { fetch } = cannedFetch(new Response(`oops ${KEY}`, { status }));
    const { player, played } = recordingPlayer();
    const error = await failureOf(voice(fetch, player).speak("Hi"));

    expect(error.message).toMatch(pattern);
    expect(error.message).toContain(String(status));
    expect(error.message).not.toContain(KEY);
    expect(played).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("maps a network failure to a VoiceError that never contains the key", async () => {
    const { fetch } = cannedFetch(new TypeError(`fetch failed (xi-api-key: ${KEY})`));
    const { player, played } = recordingPlayer();
    const error = await failureOf(voice(fetch, player).speak("Hi"));

    expect(error.message).toMatch(/reach|network/i);
    expect(error.message).not.toContain(KEY);
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect(String(error.cause ?? "")).not.toContain(KEY);
    expect(played).toHaveLength(0);
  });

  it("treats an empty audio body as a service error", async () => {
    const { fetch } = cannedFetch(new Response(new Uint8Array(), { status: 200 }));
    const { player, played } = recordingPlayer();
    const error = await failureOf(voice(fetch, player).speak("Hi"));
    expect(error.message).toMatch(/no audio/i);
    expect(played).toHaveLength(0);
  });

  it("keeps a player error message from leaking the key", async () => {
    const { fetch } = cannedFetch(audio());
    const { player } = recordingPlayer(new Error(`boom ${KEY}`));
    const error = await failureOf(voice(fetch, player).speak("Hi"));
    expect(error.message).not.toContain(KEY);
    expect(String(error.cause ?? "")).not.toContain(KEY);
  });
});

describe("ElevenLabsVoice.listen", () => {
  it("says speech in is not built yet", async () => {
    const { fetch } = cannedFetch();
    const error = await failureOf(voice(fetch, recordingPlayer().player).listen());
    expect(error.message).toMatch(/speech in is not built yet/i);
  });
});

describe("ElevenLabsVoice.fromEnv", () => {
  it("reads the key, voice id and model from the environment", async () => {
    const { fetch, calls } = cannedFetch(audio());
    const v = ElevenLabsVoice.fromEnv(
      { ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: "abc", ELEVENLABS_MODEL_ID: "eleven_flash_v2" },
      { fetch, player: recordingPlayer().player, tmpDir: dir },
    );
    await v.speak("Hi");
    expect(calls[0]!.url).toContain("/v1/text-to-speech/abc");
    expect(new Headers(calls[0]!.init.headers).get("xi-api-key")).toBe(KEY);
    expect(JSON.parse(String(calls[0]!.init.body)).model_id).toBe("eleven_flash_v2");
  });

  it("uses the default model when ELEVENLABS_MODEL_ID is unset or blank", async () => {
    const { fetch, calls } = cannedFetch(audio());
    const v = ElevenLabsVoice.fromEnv(
      { ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: "abc", ELEVENLABS_MODEL_ID: " " },
      { fetch, player: recordingPlayer().player, tmpDir: dir },
    );
    await v.speak("Hi");
    expect(JSON.parse(String(calls[0]!.init.body)).model_id).toBe(DEFAULT_MODEL_ID);
  });

  it("names the missing variable, and treats a blank value as missing", () => {
    expect(() => ElevenLabsVoice.fromEnv({ ELEVENLABS_VOICE_ID: "abc" })).toThrow(/ELEVENLABS_API_KEY/);
    expect(() => ElevenLabsVoice.fromEnv({ ELEVENLABS_API_KEY: KEY })).toThrow(/ELEVENLABS_VOICE_ID/);
    expect(() => ElevenLabsVoice.fromEnv({ ELEVENLABS_API_KEY: "  ", ELEVENLABS_VOICE_ID: "abc" })).toThrow(VoiceError);
  });
});
