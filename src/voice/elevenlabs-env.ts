import { VoiceError } from "./voice.js";

/** What `ElevenLabsVoice` takes from the environment. */
export interface ElevenLabsEnv {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  sttModelId?: string;
  baseUrl?: string;
}

/** The variables the ElevenLabs Voice cannot do without, each with the line shown when it is not set. */
const NOT_SET: Record<string, string> = {
  ELEVENLABS_API_KEY: "ELEVENLABS_API_KEY is not set. Put your ElevenLabs API key in .env, or export ELEVENLABS_API_KEY in your shell.",
  ELEVENLABS_VOICE_ID:
    "ELEVENLABS_VOICE_ID is not set. Put the id of the ElevenLabs voice to speak with in .env, " +
    "or export ELEVENLABS_VOICE_ID in your shell.",
};

/**
 * One line for each required ElevenLabs variable that is not set, a blank value counting as not set. Empty when the
 * Voice has what it needs. No line repeats a value. `npm run talk` shows these at startup, and `readElevenLabsEnv`
 * throws them, so the wording lives here alone.
 */
export function missingElevenLabsVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(NOT_SET)
    .filter(([name]) => !env[name]?.trim())
    .map(([, line]) => line);
}

/**
 * Reads `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` (required), and `ELEVENLABS_MODEL_ID`,
 * `ELEVENLABS_STT_MODEL_ID` and `ELEVENLABS_BASE_URL` (optional, a blank value counting as unset). Throws a
 * `VoiceError` holding the line of every required variable that is missing.
 */
export function readElevenLabsEnv(env: NodeJS.ProcessEnv): ElevenLabsEnv {
  const read = (name: string) => env[name]?.trim() || undefined;
  const apiKey = read("ELEVENLABS_API_KEY");
  const voiceId = read("ELEVENLABS_VOICE_ID");
  if (!apiKey || !voiceId) throw new VoiceError(missingElevenLabsVariables(env).join("\n"));

  const config: ElevenLabsEnv = { apiKey, voiceId };
  const modelId = read("ELEVENLABS_MODEL_ID");
  const sttModelId = read("ELEVENLABS_STT_MODEL_ID");
  const baseUrl = read("ELEVENLABS_BASE_URL");
  if (modelId) config.modelId = modelId;
  if (sttModelId) config.sttModelId = sttModelId;
  if (baseUrl) config.baseUrl = baseUrl;
  return config;
}
