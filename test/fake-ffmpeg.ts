import { writeFile } from "node:fs/promises";
import type { RecorderProcess, Spawner } from "../src/voice/recorder.js";

/**
 * A scripted stand-in for ffmpeg: no process is started. It writes `clip` to the output path once told to stop.
 * `failWith` makes it die at once, `failOnStop` makes it fail to finish the file, and `ignoreStop` makes it carry on
 * recording when told to stop, until it is killed.
 */
export function fakeFfmpeg(script: { clip?: Uint8Array; failWith?: Error; failOnStop?: Error; ignoreStop?: boolean } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const events: string[] = [];
  const spawn: Spawner = (command, args) => {
    calls.push({ command, args });
    events.push("start");
    const output = args[args.length - 1]!;
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    if (script.failWith) fail(script.failWith);
    const process: RecorderProcess = {
      done,
      stop() {
        events.push("stop");
        if (script.ignoreStop) return;
        if (script.failOnStop) return fail(script.failOnStop);
        const write = script.clip ? writeFile(output, script.clip) : Promise.resolve();
        void write.then(finish);
      },
      kill() {
        events.push("kill");
        fail(new Error("ffmpeg exited with code null"));
      },
    };
    return process;
  };
  return { spawn, calls, events };
}
