import { missingElevenLabsVariables } from "./voice/elevenlabs-env.js";

/** Thrown at startup when the program is not set up to run. The message is meant to be shown to the person running it. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** What `.env.example` ships, so a copied-but-unedited file counts as no key. */
const PLACEHOLDER_KEY = "sk-ant-...";

const ANTHROPIC_KEY_NOT_SET =
  "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and put your Anthropic API key in it, " +
  "or export ANTHROPIC_API_KEY in your shell.";

function anthropicKey(env: NodeJS.ProcessEnv): string | undefined {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key && key !== PLACEHOLDER_KEY ? key : undefined;
}

/** The line that says the Anthropic key is not set, or undefined when it is. For programs that list every problem at once. */
export function anthropicKeyProblem(env: NodeJS.ProcessEnv): string | undefined {
  return anthropicKey(env) ? undefined : ANTHROPIC_KEY_NOT_SET;
}

/** The Anthropic API key from the environment, or a `ConfigError` saying how to set it. */
export function requireApiKey(env: NodeJS.ProcessEnv): string {
  const key = anthropicKey(env);
  if (!key) throw new ConfigError(ANTHROPIC_KEY_NOT_SET);
  return key;
}

/**
 * Checks what a spoken Call (`npm run talk`) needs: the Anthropic key, and what the ElevenLabs Voice says it cannot do
 * without (the key and the voice id). Throws one `ConfigError` that names every variable that is missing, one line
 * each, so they can all be fixed in one go. A value is never repeated in the message.
 */
export function requireTalkConfig(env: NodeJS.ProcessEnv): void {
  const problems = [...(anthropicKey(env) ? [] : [ANTHROPIC_KEY_NOT_SET]), ...missingElevenLabsVariables(env)];
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
