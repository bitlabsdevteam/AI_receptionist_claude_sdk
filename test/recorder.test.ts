import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordClip, type RecorderProcess, type Spawner } from "../src/voice/recorder.js";
import { VoiceError, VoiceInterrupted } from "../src/voice/voice.js";

const CLIP = new Uint8Array([1, 2, 3, 4]);

/** A scripted stand-in for ffmpeg: no process is started. It writes `clip` to the output path once told to stop. */
function fakeFfmpeg(script: { clip?: Uint8Array; failWith?: Error; failOnStop?: Error } = {}) {
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
        if (script.failOnStop) return fail(script.failOnStop);
        const write = script.clip ? writeFile(output, script.clip) : Promise.resolve();
        void write.then(finish);
      },
    };
    return process;
  };
  return { spawn, calls, events };
}

let parent: string;
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "recorder-test-"));
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

const leftovers = () => readdir(parent);

describe("recordClip", () => {
  it("records with ffmpeg avfoundation into a mono 16 kHz wav, and stops only after Enter", async () => {
    const ffmpeg = fakeFfmpeg({ clip: CLIP });
    const clip = await recordClip({
      spawn: ffmpeg.spawn,
      tempDir: parent,
      waitForEnter: async () => {
        ffmpeg.events.push("enter");
      },
    });

    expect(clip).toEqual(CLIP);
    expect(ffmpeg.events).toEqual(["start", "enter", "stop"]);
    const { command, args } = ffmpeg.calls[0]!;
    expect(command).toBe("ffmpeg");
    expect(args.slice(args.indexOf("-f"), args.indexOf("-f") + 2)).toEqual(["-f", "avfoundation"]);
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", ":default"]);
    expect(args.slice(args.indexOf("-ac"), args.indexOf("-ac") + 2)).toEqual(["-ac", "1"]);
    expect(args.slice(args.indexOf("-ar"), args.indexOf("-ar") + 2)).toEqual(["-ar", "16000"]);
    expect(args.at(-1)!.startsWith(parent)).toBe(true);
    expect(args.at(-1)!.endsWith(".wav")).toBe(true);
  });

  it("removes its temp file after a recording", async () => {
    await recordClip({ spawn: fakeFfmpeg({ clip: CLIP }).spawn, tempDir: parent, waitForEnter: async () => {} });
    expect(await leftovers()).toEqual([]);
  });

  it("returns an empty clip when ffmpeg wrote nothing", async () => {
    const clip = await recordClip({ spawn: fakeFfmpeg().spawn, tempDir: parent, waitForEnter: async () => {} });
    expect(clip.byteLength).toBe(0);
    expect(await leftovers()).toEqual([]);
  });

  it("tells the Caller to install ffmpeg when it is missing, and cleans up", async () => {
    const missing = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    const error = await recordClip({
      spawn: fakeFfmpeg({ failWith: missing }).spawn,
      tempDir: parent,
      waitForEnter: () => new Promise(() => {}), // the Caller never gets to press Enter
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VoiceError);
    expect((error as Error).message).toMatch(/ffmpeg/);
    expect((error as Error).message).toMatch(/brew install ffmpeg/);
    expect(await leftovers()).toEqual([]);
  });

  it("gives the same message when the spawner throws ENOENT straight away", async () => {
    const spawn: Spawner = () => {
      throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    };
    const error = await recordClip({ spawn, tempDir: parent, waitForEnter: async () => {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceError);
    expect((error as Error).message).toMatch(/brew install ffmpeg/);
    expect(await leftovers()).toEqual([]);
  });

  it("fails with a VoiceError when ffmpeg dies while recording, and cleans up", async () => {
    const error = await recordClip({
      spawn: fakeFfmpeg({ failWith: new Error("ffmpeg exited with code 1: Permission denied") }).spawn,
      tempDir: parent,
      waitForEnter: () => new Promise(() => {}),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceError);
    expect((error as Error).message).toMatch(/Permission denied/);
    expect(await leftovers()).toEqual([]);
  });

  it("fails with a VoiceError when ffmpeg cannot finish the file, and cleans up", async () => {
    const error = await recordClip({
      spawn: fakeFfmpeg({ failOnStop: new Error("ffmpeg exited with code 255") }).spawn,
      tempDir: parent,
      waitForEnter: async () => {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceError);
    expect(await leftovers()).toEqual([]);
  });

  it("stops ffmpeg, cleans up and rethrows when the Caller interrupts", async () => {
    const ffmpeg = fakeFfmpeg({ clip: CLIP });
    const error = await recordClip({
      spawn: ffmpeg.spawn,
      tempDir: parent,
      waitForEnter: async () => {
        throw new VoiceInterrupted();
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceInterrupted);
    expect(ffmpeg.events).toEqual(["start", "stop"]);
    expect(await leftovers()).toEqual([]);
  });
});
