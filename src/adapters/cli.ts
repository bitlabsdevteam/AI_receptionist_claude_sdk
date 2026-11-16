import { createInterface } from "node:readline";
import { loadDotEnv, requireApiKey } from "../config.js";
import { runChat, type ChatIO } from "./chat.js";
import { loadFlowAndEngine, runProgram } from "./program.js";

runProgram(async () => {
  loadDotEnv();
  requireApiKey(process.env);
  const { flow, engine } = await loadFlowAndEngine();

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

  const chatResult = await runChat(engine, io, { label: flow.variables.receptionist_name ?? "Receptionist" });
  if (chatResult === "input-closed") stdout.write("\n");
  rl.close();
  return chatResult === "failed" ? 1 : 0;
});
