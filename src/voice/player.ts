import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Plays the audio file at `path` and resolves once it has finished. Injectable so tests play nothing. */
export type Player = (path: string) => Promise<void>;

/** The real Player: macOS `afplay`. Rejects if it cannot start or exits non-zero. */
export const afplayPlayer: Player = (path) =>
  new Promise((resolve, reject) => {
    execFile("afplay", [path], (error) => (error ? reject(error) : resolve()));
  });

/**
 * Writes `bytes` to a fresh temp file under `dir`, plays it, and deletes it afterwards, also when playing fails.
 * Each call gets its own directory, so nothing is left behind and calls never collide.
 */
export async function playBytes(bytes: Uint8Array, player: Player, dir: string = tmpdir(), extension = ".mp3"): Promise<void> {
  const own = await mkdtemp(join(dir, "receptionist-voice-"));
  try {
    const path = join(own, `speech${extension}`);
    await writeFile(path, bytes);
    await player(path);
  } finally {
    await rm(own, { recursive: true, force: true });
  }
}
