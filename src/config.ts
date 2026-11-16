/** Thrown at startup when the program is not set up to run. The message is meant to be shown to the person running it. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** What `.env.example` ships, so a copied-but-unedited file counts as no key. */
const PLACEHOLDER_KEY = "sk-ant-...";

type Environment = Readonly<Record<string, string | undefined>>;

const ANTHROPIC_KEY_NOT_SET =
  "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and put your Anthropic API key in it, " +
  "or export ANTHROPIC_API_KEY in your shell.";

function anthropicKey(env: Environment): string | undefined {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key && key !== PLACEHOLDER_KEY ? key : undefined;
}

/** The Anthropic API key from the environment, or a `ConfigError` saying how to set it. */
export function requireApiKey(env: Environment): string {
  const key = anthropicKey(env);
  if (!key) throw new ConfigError(ANTHROPIC_KEY_NOT_SET);
  return key;
}

/**
 * Checks what a spoken Call (`npm run talk`) needs: the Anthropic key, the ElevenLabs key and the voice id. Throws one
 * `ConfigError` that names every variable that is missing, one line each, so they can all be fixed in one go. A value
 * is never repeated in the message.
 */
export function requireTalkConfig(env: Environment): void {
  const problems: string[] = [];
  if (!anthropicKey(env)) problems.push(ANTHROPIC_KEY_NOT_SET);
  if (!env.ELEVENLABS_API_KEY?.trim()) {
    problems.push("ELEVENLABS_API_KEY is not set. Put your ElevenLabs API key in .env, or export ELEVENLABS_API_KEY in your shell.");
  }
  if (!env.ELEVENLABS_VOICE_ID?.trim()) {
    problems.push(
      "ELEVENLABS_VOICE_ID is not set. Put the id of the ElevenLabs voice to speak with in .env, " +
        "or export ELEVENLABS_VOICE_ID in your shell.",
    );
  }
  if (problems.length > 0) throw new ConfigError(problems.join("\n"));
}

/** Loads `path` (default `./.env`) into `process.env` without overriding variables already set. A missing file is fine. */
export function loadDotEnv(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
