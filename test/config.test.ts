import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadDotEnv, requireApiKey } from "../src/config.js";

describe("requireApiKey", () => {
  it("returns the key when it is set", () => {
    expect(requireApiKey({ ANTHROPIC_API_KEY: "sk-ant-real" })).toBe("sk-ant-real");
  });

  it.each([
    ["missing", {}],
    ["empty", { ANTHROPIC_API_KEY: "" }],
    ["blank", { ANTHROPIC_API_KEY: "   " }],
    ["the placeholder copied from .env.example", { ANTHROPIC_API_KEY: "sk-ant-..." }],
  ])("stops with a message that says what to do when the key is %s", (_name, env) => {
    expect(() => requireApiKey(env)).toThrow(ConfigError);
    expect(() => requireApiKey(env)).toThrow(/ANTHROPIC_API_KEY.*\.env/s);
  });
});

describe("loadDotEnv", () => {
  const dirs: string[] = [];
  const touched: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const name of touched.splice(0)) delete process.env[name];
  });

  function envFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "receptionist-env-"));
    dirs.push(dir);
    const path = join(dir, ".env");
    writeFileSync(path, contents);
    return path;
  }

  it("loads variables from the file", () => {
    touched.push("RECEPTIONIST_TEST_FROM_FILE");
    loadDotEnv(envFile("RECEPTIONIST_TEST_FROM_FILE=hello\n"));

    expect(process.env.RECEPTIONIST_TEST_FROM_FILE).toBe("hello");
  });

  it("does not override a variable already in the environment", () => {
    touched.push("RECEPTIONIST_TEST_KEEP");
    process.env.RECEPTIONIST_TEST_KEEP = "from the shell";
    loadDotEnv(envFile("RECEPTIONIST_TEST_KEEP=from the file\n"));

    expect(process.env.RECEPTIONIST_TEST_KEEP).toBe("from the shell");
  });

  it("is fine with no .env file", () => {
    expect(() => loadDotEnv(join(tmpdir(), "receptionist-no-such-dir", ".env"))).not.toThrow();
  });
});

describe("the chat program at startup", () => {
  it("stops with a clear message and a failing exit code when there is no API key, before anything is sent", () => {
    // Run from an empty directory with an empty environment, so no real .env or key can be picked up.
    const dir = mkdtempSync(join(tmpdir(), "receptionist-cli-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), resolve("src/adapters/cli.ts")],
        { cwd: dir, env: { PATH: process.env.PATH ?? "" }, input: "", encoding: "utf8", timeout: 30_000 },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ANTHROPIC_API_KEY");
      expect(result.stderr).toContain(".env");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
