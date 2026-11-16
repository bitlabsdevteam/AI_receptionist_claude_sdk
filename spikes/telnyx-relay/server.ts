import { join } from "node:path";
import { readConfig, startSpike } from "./spike.js";

/**
 * `npx tsx spikes/telnyx-relay/server.ts`: starts the spike with the values from `.env` (variables already in the
 * environment win), prints the address to expect webhooks on, and reads one key press per experiment. It does not
 * start `ngrok`, place a call or call a model.
 */

try {
  process.loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const config = readConfig(process.env, join(import.meta.dirname, "logs"));
if ("problems" in config) {
  process.stderr.write(`${config.problems.join("\n")}\n`);
  process.exit(1);
}

const spike = await startSpike(config, (line) => process.stdout.write(`${line}\n`));

let quitting = false;
function quit(): void {
  if (quitting) return;
  quitting = true;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  void spike.quit().finally(() => process.exit(0));
}

process.on("SIGINT", quit);
process.on("SIGTERM", quit);

// In a terminal each key acts at once, with no Enter. Piped input is read a character at a time too.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (chunk: Buffer) => {
  for (const key of chunk.toString()) {
    if (key === "\u0003" || key === "Q") quit();
    else spike.press(key);
  }
});
process.stdin.on("error", () => undefined);
