import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, DEFAULT_STT_MODEL_ID, ElevenLabsVoice } from "../src/voice/elevenlabs.js";
import type { Player } from "../src/voice/player.js";
import { recordClip } from "../src/voice/recorder.js";
import { VoiceError, VoiceInterrupted } from "../src/voice/voice.js";
import { fakeFfmpeg } from "./fake-ffmpeg.js";
import { wavClip } from "./wav.js";

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

/** A Voice whose recorder "records" `clip` without starting a process or opening a microphone. */
function listener(fetch: typeof globalThis.fetch, clip: Uint8Array, extra: Partial<ConstructorParameters<typeof ElevenLabsVoice>[0]> = {}) {
  return new ElevenLabsVoice({ apiKey: KEY, voiceId: "voice/1", fetch, recorder: async () => clip, ...extra });
}

const transcript = (body: unknown) => Response.json(body);
const ONE_SECOND = wavClip(1000);

describe("ElevenLabsVoice.listen", () => {
  it("uploads the recorded clip as multipart to the speech-to-text endpoint, with the key in the header only", async () => {
    const { fetch, calls } = cannedFetch(transcript({ text: "hello" }));
    await listener(fetch, ONE_SECOND).listen();

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("xi-api-key")).toBe(KEY);
    // fetch must set the multipart boundary itself.
    expect(headers.has("content-type")).toBe(false);
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model_id")).toBe("scribe_v2");
    const file = form.get("file") as File;
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...ONE_SECOND]);
    expect(url).not.toContain(KEY);
    expect([...form.values()].filter((value) => typeof value === "string").join(" ")).not.toContain(KEY);
  });
});

describe("ElevenLabsVoice.listen: the request", () => {
  const formOf = (call: Call) => call.init.body as FormData;

  it("defaults to the speech-to-text model the API reference uses, and lets it be overridden", async () => {
    expect(DEFAULT_STT_MODEL_ID).toBe("scribe_v2");
    const { fetch, calls } = cannedFetch(transcript({ text: "hello" }));
    await listener(fetch, ONE_SECOND, { sttModelId: "scribe_v3" }).listen();
    expect(formOf(calls[0]!).get("model_id")).toBe("scribe_v3");
  });

  it("asks for no audio event tags such as (laughter), which are not the Caller's words", async () => {
    const { fetch, calls } = cannedFetch(transcript({ text: "hello" }));
    await listener(fetch, ONE_SECOND).listen();
    expect(formOf(calls[0]!).get("tag_audio_events")).toBe("false");
  });

  it("labels a WAV clip as WAV, and any other clip as plain bytes", async () => {
    const { fetch, calls } = cannedFetch(transcript({ text: "hello" }), transcript({ text: "hello" }));
    await listener(fetch, ONE_SECOND).listen();
    await listener(fetch, MP3).listen();
    const [wav, other] = calls.map((call) => formOf(call).get("file") as File);
    expect([wav!.type, wav!.name]).toEqual(["audio/wav", "clip.wav"]);
    expect([other!.type, other!.name]).toEqual(["application/octet-stream", "clip"]);
  });

  it("uses the configured API host", async () => {
    const { fetch, calls } = cannedFetch(transcript({ text: "hello" }));
    await listener(fetch, ONE_SECOND, { baseUrl: "https://api.us.elevenlabs.io" }).listen();
    expect(calls[0]!.url).toBe("https://api.us.elevenlabs.io/v1/speech-to-text");
  });
});

describe("ElevenLabsVoice.listen: what was heard", () => {
  it("returns the transcript, trimmed", async () => {
    const { fetch } = cannedFetch(transcript({ language_code: "eng", text: "  Hi, I need to book an appointment.  \n", words: [] }));
    expect(await listener(fetch, ONE_SECOND).listen()).toBe("Hi, I need to book an appointment.");
  });

  it.each([
    ["an empty text", { text: "" }],
    ["a blank text", { text: "   " }],
    ["no text field", { language_code: "eng" }],
    ["a text that is not a string", { text: null }],
    ["a body that is not an object", null],
  ])("returns an empty string for %s, and invents no words", async (_name, body) => {
    const { fetch } = cannedFetch(transcript(body));
    expect(await listener(fetch, ONE_SECOND).listen()).toBe("");
  });
});

describe("ElevenLabsVoice.listen: clips too short to hear", () => {
  // ElevenLabs rejects audio under 100 ms, which is what pressing Enter twice at once records.
  it.each([
    ["a 99 ms clip", wavClip(99)],
    ["a 99 ms clip as ffmpeg writes it", wavClip(99, true)],
    ["a clip with a header and no audio", wavClip(0)],
    ["a WAV cut off before its audio", wavClip(1000).subarray(0, 36)],
    ["an empty clip", new Uint8Array(0)],
  ])("hears nothing in %s, and makes no request", async (_name, clip) => {
    const { fetch, calls } = cannedFetch();
    expect(await listener(fetch, clip).listen()).toBe("");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a clip of exactly 100 ms", wavClip(100)],
    ["a clip of exactly 100 ms as ffmpeg writes it", wavClip(100, true)],
    ["a clip that is not WAV, whose length cannot be told", new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4])],
  ])("uploads %s", async (_name, clip) => {
    const { fetch, calls } = cannedFetch(transcript({ text: "ok" }));
    expect(await listener(fetch, clip).listen()).toBe("ok");
    expect(calls).toHaveLength(1);
  });
});

describe("ElevenLabsVoice.listen: the recorder", () => {
  const failingRecorder = (error: Error) => async (): Promise<Uint8Array> => {
    throw error;
  };

  it("passes a recorder's VoiceError on unchanged, and uploads nothing", async () => {
    const { fetch, calls } = cannedFetch();
    const missing = new VoiceError("Recording needs ffmpeg, which was not found. Install it with `brew install ffmpeg`, then try again.");
    const error = await failureOf(listener(fetch, ONE_SECOND, { recorder: failingRecorder(missing) }).listen());
    expect(error).toBe(missing);
    expect(calls).toHaveLength(0);
  });

  it("passes the Caller's interrupt on unchanged, so the adapter can end the Call", async () => {
    const { fetch, calls } = cannedFetch();
    const interrupt = new VoiceInterrupted();
    const error = await failureOf(listener(fetch, ONE_SECOND, { recorder: failingRecorder(interrupt) }).listen());
    expect(error).toBe(interrupt);
    expect(calls).toHaveLength(0);
  });

  it("maps any other recorder failure to a VoiceError without the key", async () => {
    const { fetch, calls } = cannedFetch();
    const error = await failureOf(listener(fetch, ONE_SECOND, { recorder: failingRecorder(new Error(`boom ${KEY}`)) }).listen());
    expect(error.message).toMatch(/record/i);
    expect(error.message).toContain("boom");
    expect(error.message).not.toContain(KEY);
    expect(String(error.cause ?? "")).not.toContain(KEY);
    expect(calls).toHaveLength(0);
  });

  it("fails with a VoiceError that says what is missing when it was given no recorder", async () => {
    const { fetch, calls } = cannedFetch();
    const error = await failureOf(new ElevenLabsVoice({ apiKey: KEY, voiceId: "voice/1", fetch }).listen());
    expect(error.message).toMatch(/recorder/i);
    expect(calls).toHaveLength(0);
  });
});

describe("ElevenLabsVoice.listen: push-to-talk with the ffmpeg recorder", () => {
  it("records until Enter, uploads the clip, returns what was said and leaves no file behind", async () => {
    const { fetch, calls } = cannedFetch(transcript({ text: " I'd like to book a visit. " }));
    const ffmpeg = fakeFfmpeg({ clip: wavClip(1000, true) });
    const waitForEnter = async () => void ffmpeg.events.push("enter");
    const recorder = () => recordClip({ spawn: ffmpeg.spawn, tempDir: dir, waitForEnter });

    expect(await listener(fetch, ONE_SECOND, { recorder }).listen()).toBe("I'd like to book a visit.");

    expect(ffmpeg.events).toEqual(["start", "enter", "stop"]);
    const sent = (calls[0]!.init.body as FormData).get("file") as File;
    expect([...new Uint8Array(await sent.arrayBuffer())]).toEqual([...wavClip(1000, true)]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("says what to install when ffmpeg is missing, and uploads nothing", async () => {
    const { fetch, calls } = cannedFetch();
    const missing = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    const recorder = () =>
      recordClip({ spawn: fakeFfmpeg({ failWith: missing }).spawn, tempDir: dir, waitForEnter: () => new Promise(() => {}) });

    const error = await failureOf(listener(fetch, ONE_SECOND, { recorder }).listen());

    expect(error.message).toMatch(/brew install ffmpeg/);
    expect(calls).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("hears nothing, and uploads nothing, when Enter is pressed twice at once", async () => {
    const { fetch, calls } = cannedFetch();
    const recorder = () => recordClip({ spawn: fakeFfmpeg({ clip: wavClip(20, true) }).spawn, tempDir: dir, waitForEnter: async () => {} });

    expect(await listener(fetch, ONE_SECOND, { recorder }).listen()).toBe("");
    expect(calls).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("ElevenLabsVoice.listen: failures", () => {
  // The same table as `speak`: both directions share one error mapping.
  it.each([
    [401, /key/i],
    [403, /key/i],
    [429, /rate limit|quota/i],
    [500, /service/i],
    [503, /service/i],
    [404, /service/i],
    [422, /service/i],
  ])("maps HTTP %i to a VoiceError without the key", async (status, pattern) => {
    // The body deliberately echoes the key and is not JSON: the mapping must not depend on a body shape.
    const { fetch } = cannedFetch(new Response(`oops ${KEY}`, { status }));
    const error = await failureOf(listener(fetch, ONE_SECOND).listen());

    expect(error.message).toMatch(pattern);
    expect(error.message).toContain(String(status));
    expect(error.message).not.toContain(KEY);
  });

  it("maps a network failure to a VoiceError that never contains the key", async () => {
    const { fetch } = cannedFetch(new TypeError(`fetch failed (xi-api-key: ${KEY})`));
    const error = await failureOf(listener(fetch, ONE_SECOND).listen());

    expect(error.message).toMatch(/reach|network/i);
    expect(error.message).not.toContain(KEY);
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect(String(error.cause ?? "")).not.toContain(KEY);
  });

  it("treats a reply that is not JSON as a service error, not as a transcript", async () => {
    const { fetch } = cannedFetch(new Response(`<html>oops ${KEY}</html>`, { status: 200 }));
    const error = await failureOf(listener(fetch, ONE_SECOND).listen());
    expect(error.message).toMatch(/service error/i);
    expect(error.message).not.toContain(KEY);
    expect(String(error.cause ?? "")).not.toContain(KEY);
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

  it("reads the speech-to-text model from ELEVENLABS_STT_MODEL_ID, and takes an injected recorder", async () => {
    const { fetch, calls } = cannedFetch(transcript({ text: "hello" }), transcript({ text: "hello" }));
    const env = { ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: "abc" };
    const injected = { fetch, recorder: async () => ONE_SECOND };

    expect(await ElevenLabsVoice.fromEnv({ ...env, ELEVENLABS_STT_MODEL_ID: "scribe_v3" }, injected).listen()).toBe("hello");
    await ElevenLabsVoice.fromEnv({ ...env, ELEVENLABS_STT_MODEL_ID: " " }, injected).listen();

    expect(new Headers(calls[0]!.init.headers).get("xi-api-key")).toBe(KEY);
    expect((calls[0]!.init.body as FormData).get("model_id")).toBe("scribe_v3");
    expect((calls[1]!.init.body as FormData).get("model_id")).toBe(DEFAULT_STT_MODEL_ID);
  });

  it("names the missing variable, and treats a blank value as missing", () => {
    expect(() => ElevenLabsVoice.fromEnv({ ELEVENLABS_VOICE_ID: "abc" })).toThrow(/ELEVENLABS_API_KEY/);
    expect(() => ElevenLabsVoice.fromEnv({ ELEVENLABS_API_KEY: KEY })).toThrow(/ELEVENLABS_VOICE_ID/);
    expect(() => ElevenLabsVoice.fromEnv({ ELEVENLABS_API_KEY: "  ", ELEVENLABS_VOICE_ID: "abc" })).toThrow(VoiceError);
  });
});
