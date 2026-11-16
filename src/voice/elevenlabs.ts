import { afplayPlayer, playBytes, type Player } from "./player.js";
import type { Recorder } from "./recorder.js";
import { VoiceError, type Voice } from "./voice.js";

/** Low-latency text-to-speech model with a documented 40,000 character limit. Override with `ELEVENLABS_MODEL_ID`. */
export const DEFAULT_MODEL_ID = "eleven_flash_v2_5";

/** Speech-to-text model, the one the API reference uses. The endpoint requires one. Override with `ELEVENLABS_STT_MODEL_ID`. */
export const DEFAULT_STT_MODEL_ID = "scribe_v2";

/** ElevenLabs rejects audio shorter than this, so a shorter clip counts as nothing heard and is never uploaded. */
const MIN_CLIP_MS = 100;

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const OUTPUT_FORMAT = "mp3_44100_128";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  /** Text-to-speech model. Defaults to `DEFAULT_MODEL_ID`. */
  modelId?: string | undefined;
  /** Speech-to-text model. Defaults to `DEFAULT_STT_MODEL_ID`. */
  sttModelId?: string | undefined;
  /** API host, for the regional endpoints. */
  baseUrl?: string;
  /** Give up on the request after this long. */
  timeoutMs?: number;
  /** HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Plays the mp3. Defaults to macOS `afplay`. */
  player?: Player;
  /** Where the temp mp3 is written. Defaults to `os.tmpdir()`. */
  tmpDir?: string;
  /** Records the Caller for `listen()`, for example `() => recordClip({ waitForEnter })`. */
  recorder?: Recorder;
}

type Environment = Record<string, string | undefined>;
type Injected = Pick<ElevenLabsConfig, "baseUrl" | "timeoutMs" | "fetch" | "player" | "tmpDir" | "recorder">;

/**
 * The Voice backed by ElevenLabs. `speak` sends the text to the text-to-speech endpoint, plays the mp3 and deletes it.
 * `listen` is push-to-talk: the recorder returns one clip of the Caller, which goes to the speech-to-text endpoint, and
 * the transcript comes back trimmed (empty when nothing was heard). No message or `cause` this class raises contains
 * the API key.
 */
export class ElevenLabsVoice implements Voice {
  readonly #config: ElevenLabsConfig;

  constructor(config: ElevenLabsConfig) {
    this.#config = config;
  }

  /**
   * Reads `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` (required), and `ELEVENLABS_MODEL_ID`,
   * `ELEVENLABS_STT_MODEL_ID` and `ELEVENLABS_BASE_URL` (optional). The recorder is not in the environment: pass it in
   * `injected`, which wins over the environment.
   */
  static fromEnv(env: Environment = process.env, injected: Injected = {}): ElevenLabsVoice {
    const apiKey = env.ELEVENLABS_API_KEY?.trim();
    const voiceId = env.ELEVENLABS_VOICE_ID?.trim();
    if (!apiKey) throw new VoiceError("ELEVENLABS_API_KEY is not set. Put your ElevenLabs API key in .env or the environment.");
    if (!voiceId) throw new VoiceError("ELEVENLABS_VOICE_ID is not set. Put the id of the ElevenLabs voice to use in .env or the environment.");
    const modelId = env.ELEVENLABS_MODEL_ID?.trim() || undefined;
    const sttModelId = env.ELEVENLABS_STT_MODEL_ID?.trim() || undefined;
    const baseUrl = env.ELEVENLABS_BASE_URL?.trim();
    return new ElevenLabsVoice({ apiKey, voiceId, modelId, sttModelId, ...(baseUrl ? { baseUrl } : {}), ...injected });
  }

  async speak(text: string): Promise<void> {
    if (!text.trim()) return;
    const audio = await this.#synthesize(text);
    try {
      await playBytes(audio, this.#config.player ?? afplayPlayer, this.#config.tmpDir);
    } catch (e) {
      throw new VoiceError(`Could not play the speech: ${this.#describe(e)}`, { cause: this.#safeCause(e) });
    }
  }

  async listen(onRecorded?: () => void): Promise<string> {
    const { recorder } = this.#config;
    if (!recorder) throw new VoiceError("Speech in needs a recorder, and this Voice was given none.");
    let clip: Uint8Array;
    try {
      clip = await recorder();
    } catch (e) {
      // A VoiceError is the recorder's own account, and a VoiceInterrupted must reach the adapter as it is.
      if (e instanceof VoiceError) throw e;
      throw new VoiceError(`Could not record: ${this.#describe(e)}`, { cause: this.#safeCause(e) });
    }
    onRecorded?.();
    return this.#transcribe(clip);
  }

  async #transcribe(clip: Uint8Array): Promise<string> {
    if (clipMs(clip) < MIN_CLIP_MS) return "";

    const form = new FormData();
    form.set("model_id", this.#config.sttModelId || DEFAULT_STT_MODEL_ID);
    // Tags such as (laughter) would be written into the text, and they are not the Caller's words.
    form.set("tag_audio_events", "false");
    const [type, name] = isWav(clip) ? ["audio/wav", "clip.wav"] : ["application/octet-stream", "clip"];
    form.set("file", new Blob([clip as Uint8Array<ArrayBuffer>], { type }), name);
    // No content-type header: fetch sets the multipart boundary itself.
    const response = await this.#post("/v1/speech-to-text", {}, form);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // The parse error is dropped: it can quote the body, and the body could echo anything.
      throw new VoiceError("ElevenLabs service error: the response was not a transcript.");
    }
    const text = typeof body === "object" && body !== null ? (body as { text?: unknown }).text : undefined;
    // Anything that is not a transcript counts as nothing heard. Words are never made up.
    return typeof text === "string" ? text.trim() : "";
  }

  async #synthesize(text: string): Promise<Uint8Array> {
    const { voiceId, modelId } = this.#config;
    const response = await this.#post(
      `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`,
      { "content-type": "application/json", accept: "audio/mpeg" },
      JSON.stringify({ text, model_id: modelId || DEFAULT_MODEL_ID }),
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new VoiceError("ElevenLabs service error: the response had no audio.");
    return bytes;
  }

  /** One request to ElevenLabs, with the key in a header. Speech out and speech in share this, so they fail alike. */
  async #post(path: string, headers: Record<string, string>, body: string | FormData): Promise<Response> {
    const { apiKey, baseUrl, timeoutMs } = this.#config;
    const doFetch = this.#config.fetch ?? globalThis.fetch;

    let response: Response;
    try {
      response = await doFetch(`${baseUrl ?? DEFAULT_BASE_URL}${path}`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, ...headers },
        body,
        signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      throw new VoiceError(`Could not reach ElevenLabs: ${this.#describe(e)}`, { cause: this.#safeCause(e) });
    }

    if (!response.ok) {
      // Never read the body: its shape is not relied on, and it could echo anything.
      void response.body?.cancel().catch(() => {});
      throw new VoiceError(httpFailure(response.status));
    }
    return response;
  }

  /** The error's message with the key removed. */
  #describe(e: unknown): string {
    const message = e instanceof Error ? e.message : String(e);
    return message.split(this.#config.apiKey).join("[redacted]");
  }

  /** A stand-in for the original error that keeps its name and redacted message but none of its other properties. */
  #safeCause(e: unknown): Error {
    const safe = new Error(this.#describe(e));
    if (e instanceof Error) safe.name = e.name;
    return safe;
  }
}

function httpFailure(status: number): string {
  if (status === 401 || status === 403) return `ElevenLabs rejected the API key (HTTP ${status}). Check ELEVENLABS_API_KEY.`;
  if (status === 429) return `ElevenLabs rate limit or quota reached (HTTP ${status}). Try again shortly or check your plan.`;
  return `ElevenLabs service error (HTTP ${status}).`;
}

/**
 * The length of a WAV clip in ms. A clip in another format, or one whose length cannot be told, counts as long enough,
 * unless it is empty. The audio is measured from where the `data` chunk starts to the end of the clip, since ffmpeg
 * puts a `LIST` chunk before it and can leave the declared size stale.
 */
function clipMs(clip: Uint8Array): number {
  if (clip.byteLength === 0) return 0;
  if (!isWav(clip)) return Infinity;
  const view = new DataView(clip.buffer, clip.byteOffset, clip.byteLength);

  let byteRate = 0;
  for (let chunk = 12; chunk + 8 <= clip.byteLength; ) {
    const body = chunk + 8;
    const size = view.getUint32(chunk + 4, true);
    if (tagAt(clip, chunk) === "fmt " && body + 12 <= clip.byteLength) byteRate = view.getUint32(body + 8, true);
    if (tagAt(clip, chunk) === "data") return byteRate === 0 ? Infinity : ((clip.byteLength - body) / byteRate) * 1000;
    chunk = body + size + (size % 2);
  }
  // A WAV with no audio chunk at all has nothing in it to hear.
  return 0;
}

function isWav(clip: Uint8Array): boolean {
  return clip.byteLength >= 12 && tagAt(clip, 0) === "RIFF" && tagAt(clip, 8) === "WAVE";
}

/** The four-letter tag at `offset`, which is how a WAV names itself and each of its chunks. */
function tagAt(clip: Uint8Array, offset: number): string {
  return String.fromCharCode(...clip.subarray(offset, offset + 4));
}
