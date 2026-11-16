import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ConfigError, loadDotEnv, requireTalkConfig } from "../config.js";
import { AnthropicModelClient } from "../engine/anthropic-client.js";
import { FlowEngine } from "../engine/engine.js";
import { loadFlow } from "../flow/load.js";
import { ElevenLabsVoice } from "../voice/elevenlabs.js";
import { recordClip } from "../voice/recorder.js";
import { openTalkTerminal } from "./talk-terminal.js";
import { runTalk } from "./talk.js";

/** Used when FLOW_PATH is not set. Relative to the project, not to where the program was started from. */
const DEFAULT_FLOW_PATH = fileURLToPath(new URL("../../flows/receptionist.json", import.meta.url));

async function main(): Promise<number> {
  try {
    loadDotEnv();
    requireTalkConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  const flow = await loadFlow(process.env.FLOW_PATH ? resolve(process.env.FLOW_PATH) : DEFAULT_FLOW_PATH);
  const engine = new FlowEngine(flow, { client: new AnthropicModelClient() });

  const terminal = openTalkTerminal(process.stdin, process.stdout, () => process.exit(0));
  const voice = ElevenLabsVoice.fromEnv(process.env, { recorder: () => recordClip({ waitForEnter: terminal.waitForEnter }) });

  const talkResult = await runTalk(engine, voice, terminal.io, {
    label: flow.variables.receptionist_name ?? "Receptionist",
    clock: () => performance.now(),
  });
  if (talkResult === "input-closed") process.stdout.write("\n");
  terminal.close();
  return talkResult === "failed" ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
