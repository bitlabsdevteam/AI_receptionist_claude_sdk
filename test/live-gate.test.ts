import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The gate on the live Voice check (`test/live-voice.test.ts`), proved offline by running the package scripts in a
 * child process and reading vitest's JSON report.
 *
 * Both keys are passed as empty. An empty variable in the environment wins over `.env`, so even on a machine with real
 * keys, and even if the gate were broken, the child cannot make a request that spends money.
 */
/** The checkout this file is in. The scripts are run there, wherever vitest itself was started from. */
const PROJECT = fileURLToPath(new URL("..", import.meta.url));

const NO_KEYS = { PATH: process.env.PATH ?? "", ANTHROPIC_API_KEY: "", ELEVENLABS_API_KEY: "" };

interface Check {
  status: string;
  failureMessages: string[];
}

/** Runs `npm run <script>` with no keys and returns its exit code and what became of each live Voice check. */
function voiceChecks(script: "test" | "test:live", ...args: string[]): { exitCode: number | null; checks: Check[] } {
  const dir = mkdtempSync(join(tmpdir(), "receptionist-live-gate-"));
  try {
    const report = join(dir, "report.json");
    const result = spawnSync("npm", ["run", script, "--", ...args, "--reporter=json", `--outputFile=${report}`], {
      cwd: PROJECT,
      env: NO_KEYS,
      encoding: "utf8",
      timeout: 60_000,
    });
    let files: Array<{ name: string; assertionResults: Check[] }>;
    try {
      files = JSON.parse(readFileSync(report, "utf8")).testResults;
    } catch {
      throw new Error(`npm run ${script} wrote no report.\n${result.stdout}\n${result.stderr}`);
    }
    const checks = files.filter((file) => file.name.endsWith("test/live-voice.test.ts")).flatMap((file) => file.assertionResults);
    return { exitCode: result.status, checks };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the live Voice check", () => {
  it("is skipped by `npm test`, which therefore needs no key and no network", { timeout: 60_000 }, () => {
    const { exitCode, checks } = voiceChecks("test", "test/live-voice.test.ts");

    expect(exitCode).toBe(0);
    expect(new Set(checks.map((check) => check.status))).toEqual(new Set(["skipped"]));
  });

  it("is run by `npm run test:live`, and every check stops on the missing-key message before anything is sent", { timeout: 60_000 }, () => {
    const { exitCode, checks } = voiceChecks("test:live");

    expect(exitCode).toBe(1);
    expect(new Set(checks.map((check) => check.status))).toEqual(new Set(["failed"]));
    for (const check of checks) expect(check.failureMessages.join("\n")).toContain("ELEVENLABS_API_KEY is not set");
  });
});
