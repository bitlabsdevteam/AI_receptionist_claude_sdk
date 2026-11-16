import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadDotEnv, requireApiKey, requireTalkConfig } from "../src/config.js";

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

describe("requireTalkConfig", () => {
  const complete = { ANTHROPIC_API_KEY: "sk-ant-real", ELEVENLABS_API_KEY: "sk_real", ELEVENLABS_VOICE_ID: "voice-1" };

  function messageFor(env: Record<string, string | undefined>): string {
    try {
      requireTalkConfig(env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).message;
    }
    throw new Error("expected a ConfigError");
  }

  it("passes when the Anthropic key, the ElevenLabs key and the voice id are all set", () => {
    expect(() => requireTalkConfig(complete)).not.toThrow();
  });

  it.each(["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"] as const)(
    "reports %s by name, and no other variable, when only it is missing",
    (name) => {
      const message = messageFor({ ...complete, [name]: undefined });

      expect(message).toContain(`${name} is not set`);
      expect(message.match(/is not set/g)).toHaveLength(1);
      expect(message).toContain(".env");
    },
  );

  it.each([
    ["empty, as .env.example ships it", { ELEVENLABS_API_KEY: "" }, "ELEVENLABS_API_KEY"],
    ["blank", { ELEVENLABS_VOICE_ID: "   " }, "ELEVENLABS_VOICE_ID"],
    ["the placeholder copied from .env.example", { ANTHROPIC_API_KEY: "sk-ant-..." }, "ANTHROPIC_API_KEY"],
  ])("counts a variable that is %s as not set", (_name, override, variable) => {
    expect(messageFor({ ...complete, ...override })).toContain(`${variable} is not set`);
  });

  it("reports every missing variable at once, one line each", () => {
    const lines = messageFor({}).split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("ANTHROPIC_API_KEY is not set");
    expect(lines[1]).toContain("ELEVENLABS_API_KEY is not set");
    expect(lines[2]).toContain("ELEVENLABS_VOICE_ID is not set");
  });

  it("never repeats a value it was given", () => {
    const message = messageFor({ ANTHROPIC_API_KEY: "sk-ant-real", ELEVENLABS_API_KEY: "sk_SECRET", ELEVENLABS_VOICE_ID: "" });

    expect(message).not.toContain("sk_SECRET");
    expect(message).not.toContain("sk-ant-real");
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
