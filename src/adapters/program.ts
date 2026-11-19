import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AnthropicModelClient } from "../engine/anthropic-client.js";
import { FlowEngine } from "../engine/engine.js";
import { loadFlow } from "../flow/load.js";
import type { Flow } from "../flow/schema.js";
import { messageOf } from "./message-of.js";

/** What `npm run chat` and `npm run talk` share: the Flow they load, the engine they run it on, and how they exit. */

/** Used when FLOW_PATH is not set. Relative to the project, not to where the program was started from. */
const DEFAULT_FLOW_PATH = fileURLToPath(new URL("../../flows/receptionist.json", import.meta.url));

/** Loads the Flow that `FLOW_PATH` names (the project's own when it is unset) and an engine that runs it on the real model. */
export async function loadFlowAndEngine(): Promise<{ flow: Flow; engine: FlowEngine }> {
  const flow = await loadFlow(process.env.FLOW_PATH ? resolve(process.env.FLOW_PATH) : DEFAULT_FLOW_PATH);
  return { flow, engine: new FlowEngine(flow, { client: new AnthropicModelClient() }) };
}

/**
 * Runs a program and exits with the code `main` returns. If `main` throws, the error's message goes to stderr on its
 * own, which is how a `ConfigError` is meant to be shown, and the program exits 1.
 */
export function runProgram(main: () => Promise<number>): void {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${messageOf(error)}\n`);
      process.exit(1);
    },
  );
}
