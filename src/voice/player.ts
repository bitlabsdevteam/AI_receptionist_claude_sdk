import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTempDir } from "./temp-dir.js";

/** Plays the audio file at `path` and resolves once it has finished. Injectable so tests play nothing. */
export type Player = (path: string) => Promise<void>;

/** The real Player: macOS `afplay`. Rejects if it cannot start or exits non-zero. */
export const afplayPlayer: Player = (path) =>
  new Promise((resolve, reject) => {
    execFile("afplay", [path], (error) => (error ? reject(error) : resolve()));
  });

/**
 * Writes the mp3 in `bytes` to a fresh temp file under `tempDir`, plays it, and deletes it afterwards, also when
 * playing fails.
 */
export function playBytes(bytes: Uint8Array, player: Player, tempDir: string = tmpdir()): Promise<void> {
  return withTempDir(tempDir, async (dir) => {
    const path = join(dir, "speech.mp3");
    await writeFile(path, bytes);
    await player(path);
  });
}
