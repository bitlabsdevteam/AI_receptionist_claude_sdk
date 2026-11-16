import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Makes a fresh directory under `parent`, hands it to `use`, and removes it with everything in it afterwards, also
 * when `use` fails. Each call gets its own directory, so nothing is left behind and calls never collide.
 */
export async function withTempDir<T>(parent: string, use: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(parent, "receptionist-"));
  try {
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
