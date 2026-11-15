/** Thrown at startup when the program is not set up to run. The message is meant to be shown to the person running it. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** What `.env.example` ships, so a copied-but-unedited file counts as no key. */
const PLACEHOLDER_KEY = "sk-ant-...";

/** The Anthropic API key from the environment, or a `ConfigError` saying how to set it. */
export function requireApiKey(env: Readonly<Record<string, string | undefined>>): string {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key || key === PLACEHOLDER_KEY) {
    throw new ConfigError(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and put your Anthropic API key in it, " +
        "or export ANTHROPIC_API_KEY in your shell.",
    );
  }
  return key;
}

/** Loads `path` (default `./.env`) into `process.env` without overriding variables already set. A missing file is fine. */
export function loadDotEnv(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
