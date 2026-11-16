import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordClip, type Spawner } from "../src/voice/recorder.js";
import { VoiceError, VoiceInterrupted } from "../src/voice/voice.js";
import { fakeFfmpeg } from "./fake-ffmpeg.js";

const CLIP = new Uint8Array([1, 2, 3, 4]);

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

  it("calls off the wait for Enter when ffmpeg dies first, so the wait cannot swallow the Caller's next line", async () => {
    let wait: AbortSignal | undefined;
    const missing = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    await recordClip({
      spawn: fakeFfmpeg({ failWith: missing }).spawn,
      tempDir: parent,
      waitForEnter: (signal) => {
        wait = signal;
        expect(signal.aborted).toBe(false);
        return new Promise(() => {});
      },
    }).catch(() => {});

    expect(wait?.aborted).toBe(true);
  });

  it("fails with one VoiceError, and leaves no stray rejection, when the wait for Enter throws at once after ffmpeg died", async () => {
    // vitest fails the run on an unhandled rejection, which is what the dead recorder's `done` would otherwise become.
    const error = await recordClip({
      spawn: fakeFfmpeg({ failWith: new Error("ffmpeg exited with code 1") }).spawn,
      tempDir: parent,
      waitForEnter: () => {
        throw new Error("the terminal is closed");
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceError);
    expect((error as Error).message).toMatch(/the terminal is closed/);
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

  it("kills an ffmpeg that ignores the request to stop, fails with a VoiceError instead of hanging, and cleans up", { timeout: 2000 }, async () => {
    const ffmpeg = fakeFfmpeg({ clip: CLIP, ignoreStop: true });
    const error = await recordClip({ spawn: ffmpeg.spawn, tempDir: parent, stopGraceMs: 20, waitForEnter: async () => {} }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(VoiceError);
    expect((error as Error).message).toMatch(/did not stop/);
    expect(ffmpeg.events).toEqual(["start", "stop", "kill"]);
    expect(await leftovers()).toEqual([]);
  });

  it("kills an ffmpeg that ignores the request to stop when the Caller interrupts, and still reports the interrupt", { timeout: 2000 }, async () => {
    const ffmpeg = fakeFfmpeg({ clip: CLIP, ignoreStop: true });
    const error = await recordClip({
      spawn: ffmpeg.spawn,
      tempDir: parent,
      stopGraceMs: 20,
      waitForEnter: async () => {
        throw new VoiceInterrupted();
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VoiceInterrupted);
    expect(ffmpeg.events).toEqual(["start", "stop", "kill"]);
    expect(await leftovers()).toEqual([]);
  });

  it("does not kill an ffmpeg that stops when asked", async () => {
    const ffmpeg = fakeFfmpeg({ clip: CLIP });
    await recordClip({ spawn: ffmpeg.spawn, tempDir: parent, stopGraceMs: 20, waitForEnter: async () => {} });
    // Longer than the grace, so a timer left running would show up as a kill.
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(ffmpeg.events).toEqual(["start", "stop"]);
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

describe("recordClip with its own spawner", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("kills a recorder process that ignores the request to stop, and leaves no process and no file behind", async () => {
    // The only thing on the PATH is a stand-in for ffmpeg, so the real one cannot be started and no microphone is
    // opened. It notes its process id, then carries on whatever it is sent.
    const bin = join(parent, "bin");
    const work = join(parent, "work");
    const pidFile = join(parent, "pid");
    await mkdir(bin);
    await mkdir(work);
    await writeFile(join(bin, "ffmpeg"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec /bin/sleep 30\n`, { mode: 0o755 });
    vi.stubEnv("PATH", bin);

    const error = await recordClip({
      tempDir: work,
      stopGraceMs: 200,
      waitForEnter: () => vi.waitFor(() => expect(existsSync(pidFile)).toBe(true)),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VoiceError);
    expect((error as Error).message).toMatch(/did not stop/);
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    // Signal 0 only asks whether the process exists.
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    expect(await readdir(work)).toEqual([]);
  });
});
