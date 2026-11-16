import { afplayPlayer, playBytes, type Player } from "./player.js";
import { VoiceError, type Voice } from "./voice.js";

/** Low-latency text-to-speech model with a documented 40,000 character limit. Override with `ELEVENLABS_MODEL_ID`. */
export const DEFAULT_MODEL_ID = "eleven_flash_v2_5";

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const OUTPUT_FORMAT = "mp3_44100_128";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  /** Text-to-speech model. Defaults to `DEFAULT_MODEL_ID`. */
  modelId?: string | undefined;
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
}

type Environment = Record<string, string | undefined>;
type Injected = Pick<ElevenLabsConfig, "baseUrl" | "timeoutMs" | "fetch" | "player" | "tmpDir">;

/**
 * The Voice backed by ElevenLabs. Speech out is built: `speak` sends the text to the text-to-speech endpoint, plays
 * the mp3 and deletes it. Speech in is not built yet. No message or `cause` this class raises contains the API key.
 */
export class ElevenLabsVoice implements Voice {
  readonly #config: ElevenLabsConfig;

  constructor(config: ElevenLabsConfig) {
    this.#config = config;
  }

  /** Reads `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` (required) and `ELEVENLABS_MODEL_ID` (optional). */
  static fromEnv(env: Environment = process.env, injected: Injected = {}): ElevenLabsVoice {
    const apiKey = env.ELEVENLABS_API_KEY?.trim();
    const voiceId = env.ELEVENLABS_VOICE_ID?.trim();
    if (!apiKey) throw new VoiceError("ELEVENLABS_API_KEY is not set. Put your ElevenLabs API key in .env or the environment.");
    if (!voiceId) throw new VoiceError("ELEVENLABS_VOICE_ID is not set. Put the id of the ElevenLabs voice to use in .env or the environment.");
    const modelId = env.ELEVENLABS_MODEL_ID?.trim() || undefined;
    return new ElevenLabsVoice({ apiKey, voiceId, modelId, ...injected });
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

  async listen(): Promise<string> {
    throw new VoiceError("Speech in is not built yet.");
  }

  async #synthesize(text: string): Promise<Uint8Array> {
    const { apiKey, voiceId, modelId, baseUrl, timeoutMs } = this.#config;
    const doFetch = this.#config.fetch ?? globalThis.fetch;
    const url = `${baseUrl ?? DEFAULT_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`;

    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: modelId || DEFAULT_MODEL_ID }),
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

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new VoiceError("ElevenLabs service error: the response had no audio.");
    return bytes;
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
