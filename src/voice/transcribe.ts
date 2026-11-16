import { VoiceError } from "./voice.js";

const ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";

/** ElevenLabs rejects audio shorter than this, so a shorter clip counts as nothing heard and is never uploaded. */
export const MIN_CLIP_MS = 100;

export interface TranscribeOptions {
  apiKey: string;
  /** The speech-to-text model, such as `scribe_v2`. The endpoint requires one. */
  modelId: string;
  /** Injected so tests use canned HTTP. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Sends one clip to ElevenLabs speech-to-text and returns what was said, trimmed. Returns an empty string when nothing
 * was heard (a clip under 100 ms, or a response with no text); it never invents words. The clip is a WAV file (the
 * recorder makes 16 kHz mono 16-bit). Throws `VoiceError` on any HTTP or network failure; the API key never appears in
 * the message.
 */
export async function transcribe(options: TranscribeOptions, audio: Uint8Array): Promise<string> {
  const { apiKey, modelId, fetch = globalThis.fetch } = options;
  if (clipMs(audio) < MIN_CLIP_MS) return "";

  const form = new FormData();
  form.set("model_id", modelId);
  form.set("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "clip.wav");

  const scrub = (text: string) => (apiKey === "" ? text : text.split(apiKey).join("[redacted]"));
  let response: Response;
  try {
    // No content-type header: fetch sets the multipart boundary itself.
    response = await fetch(ENDPOINT, { method: "POST", headers: { "xi-api-key": apiKey }, body: form });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new VoiceError(`Could not reach ElevenLabs speech-to-text: ${scrub(reason)}`);
  }

  if (!response.ok) throw new VoiceError(httpFailure(response.status));

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new VoiceError("ElevenLabs speech-to-text sent a response that is not JSON.");
  }
  const text = typeof body === "object" && body !== null ? (body as { text?: unknown }).text : undefined;
  return typeof text === "string" ? text.trim() : "";
}

function httpFailure(status: number): string {
  if (status === 401) return "ElevenLabs rejected the API key (HTTP 401). Check ELEVENLABS_API_KEY.";
  if (status === 429) return "ElevenLabs speech-to-text is rate limited or busy (HTTP 429). Please try again.";
  if (status >= 500) return `ElevenLabs speech-to-text is unavailable (HTTP ${status}). Please try again.`;
  return `ElevenLabs speech-to-text failed (HTTP ${status}).`;
}

/** The length of a PCM WAV clip in ms, read from its header. Anything else counts as long enough, unless it is empty. */
function clipMs(audio: Uint8Array): number {
  if (audio.byteLength === 0) return 0;
  const isWav = audio.byteLength >= 44 && String.fromCharCode(...audio.subarray(0, 4)) === "RIFF";
  if (!isWav) return Infinity;
  const byteRate = new DataView(audio.buffer, audio.byteOffset, audio.byteLength).getUint32(28, true);
  if (byteRate === 0) return Infinity;
  return ((audio.byteLength - 44) / byteRate) * 1000;
}
