import { spawn as spawnProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceError } from "./voice.js";

/** Records the Caller once and returns the clip. `ElevenLabsVoice.listen()` uploads whatever this returns. */
export type Recorder = () => Promise<Uint8Array>;

/** A running recorder. `stop()` asks it to finish the file; `done` settles once it has exited (rejects if it failed). */
export interface RecorderProcess {
  stop(): void;
  done: Promise<void>;
}

/** Starts a command. Injected so tests start no process and open no microphone. */
export type Spawner = (command: string, args: string[]) => RecorderProcess;

export interface RecordOptions {
  /**
   * Resolves when the Caller presses Enter to stop. May reject with `VoiceInterrupted`. `signal` aborts once the
   * recording no longer waits (the recorder died first), so that a pending read can be called off before it swallows
   * the Caller's next line.
   */
  waitForEnter: (signal: AbortSignal) => Promise<void>;
  spawn?: Spawner;
  /** Where the temp directory is made. Defaults to the OS temp directory. */
  tempDir?: string;
  /** The avfoundation input, `:default` being the default microphone. */
  input?: string;
}

const MISSING_FFMPEG =
  "Recording needs ffmpeg, which was not found. Install it with `brew install ffmpeg`, then try again.";

/**
 * Records the Caller from the microphone until `waitForEnter` resolves, and returns the clip as 16 kHz mono 16-bit
 * WAV bytes (empty if ffmpeg wrote nothing). ffmpeg is started at once: the adapter's Enter at its prompt is the
 * start, and the Enter awaited here is the stop. Nothing here knows when ffmpeg has opened the microphone, which can
 * take a moment, so words said straight away may be missed. macOS only (avfoundation). The temp file is removed
 * whatever happens. Throws `VoiceError`; a missing `ffmpeg` names what to install.
 */
export async function recordClip(options: RecordOptions): Promise<Uint8Array> {
  const { waitForEnter, spawn = spawnFfmpeg, tempDir = tmpdir(), input = ":default" } = options;
  const dir = await mkdtemp(join(tempDir, "receptionist-"));
  const file = join(dir, "clip.wav");
  const waiting = new AbortController();
  let recorder: RecorderProcess | undefined;
  try {
    recorder = spawn("ffmpeg", [
      ...["-hide_banner", "-loglevel", "error"],
      ...["-f", "avfoundation", "-i", input],
      ...["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", file],
    ]);
    // A recorder that dies early (no ffmpeg, no microphone permission) must not wait for Enter.
    const died = recorder.done.then(() => new Promise<never>(() => {}));
    // The race below is what reports a death. Should it never start, this keeps the rejection from going unhandled.
    died.catch(() => {});
    await Promise.race([waitForEnter(waiting.signal), died]);
    recorder.stop();
    await recorder.done;
    return await readClip(file);
  } catch (error) {
    if (recorder) {
      recorder.stop();
      await recorder.done.catch(() => {});
    }
    throw asVoiceError(error);
  } finally {
    waiting.abort();
    await rm(dir, { recursive: true, force: true });
  }
}

async function readClip(file: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Uint8Array(0);
    throw error;
  }
}

function asVoiceError(error: unknown): unknown {
  if (error instanceof VoiceError) return error;
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return new VoiceError(MISSING_FFMPEG, { cause: error });
  const reason = error instanceof Error ? error.message : String(error);
  return new VoiceError(`Recording failed: ${reason}`, { cause: error });
}

/** The real recorder. ffmpeg finishes the file and exits 0 when it reads `q` on stdin. */
const spawnFfmpeg: Spawner = (command, args) => {
  const child = spawnProcess(command, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-500);
  });
  child.stdin.on("error", () => {});
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
  return { done, stop: () => void child.stdin.end("q") };
};
