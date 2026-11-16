import { loadDotEnv, requireTalkConfig } from "../config.js";
import { ElevenLabsVoice } from "../voice/elevenlabs.js";
import { recordClip } from "../voice/recorder.js";
import { loadFlowAndEngine, runProgram } from "./program.js";
import { openTalkTerminal } from "./talk-terminal.js";
import { runTalk } from "./talk.js";

runProgram(async () => {
  loadDotEnv();
  requireTalkConfig(process.env);
  const { flow, engine } = await loadFlowAndEngine();

  const terminal = openTalkTerminal(process.stdin, process.stdout, () => process.exit(0));
  const voice = ElevenLabsVoice.fromEnv(process.env, { recorder: () => recordClip({ waitForEnter: terminal.waitForEnter }) });

  const talkResult = await runTalk(engine, voice, terminal.io, {
    label: flow.variables.receptionist_name ?? "Receptionist",
    clock: () => performance.now(),
  });
  if (talkResult === "input-closed") process.stdout.write("\n");
  terminal.close();
  return talkResult === "failed" ? 1 : 0;
});
