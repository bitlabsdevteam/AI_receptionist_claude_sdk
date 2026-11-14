import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ConfigError, loadDotEnv, requireApiKey } from "../config.js";
import { AnthropicModelClient } from "../engine/anthropic-client.js";
import { FlowEngine } from "../engine/engine.js";
import { loadFlow } from "../flow/load.js";
import { runChat, type ChatIO } from "./chat.js";

/** Used when FLOW_PATH is not set. Relative to the project, not to where the program was started from. */
const DEFAULT_FLOW_PATH = fileURLToPath(new URL("../../flows/receptionist.json", import.meta.url));

async function main(): Promise<number> {
  try {
    loadDotEnv();
    requireApiKey(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  const flow = await loadFlow(process.env.FLOW_PATH ? resolve(process.env.FLOW_PATH) : DEFAULT_FLOW_PATH);
  const engine = new FlowEngine(flow, { client: new AnthropicModelClient() });

  const { stdin, stdout } = process;
  const rl = createInterface({ input: stdin, output: stdout });
  // Ctrl-C quits at once, even while a reply is streaming.
  rl.on("SIGINT", () => {
    stdout.write("\n");
    process.exit(0);
  });

  const lines = rl[Symbol.asyncIterator]();
  const io: ChatIO = {
    write: (text) => void stdout.write(text),
    async ask(prompt) {
      // readline owns the prompt on a terminal so that line editing redraws it. Piped input can end, and so close
      // readline, before the Receptionist has finished speaking, so there the prompt is just written.
      if (stdin.isTTY) {
        rl.setPrompt(prompt);
        rl.prompt();
      } else {
        stdout.write(prompt);
      }
      const next = await lines.next();
      if (next.done) return undefined;
      // A pipe is not echoed back by the terminal, so show the line to keep the transcript readable.
      if (!stdin.isTTY) stdout.write(`${next.value}\n`);
      return next.value;
    },
    get columns() {
      return stdout.isTTY ? stdout.columns : undefined;
    },
  };

  const outcome = await runChat(engine, io, { label: flow.variables.assistant_name ?? "Receptionist" });
  if (outcome === "input-closed") stdout.write("\n");
  rl.close();
  return outcome === "failed" ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
