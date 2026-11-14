import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finish, messageStart, sseBody, textBlock, toolBlock, type Json } from "./sse.js";

/**
 * Runs the real program, as `npm run chat` does, with a throwaway HTTP server standing in for Anthropic. It proves the
 * wiring (env, flow, SDK, engine, readline, exit codes) and nothing about the live model.
 */

const GREETING_WORDS = ["Hello,", " this", " is", " Ava", " from", " Acme", " Co."];

interface Fake {
  server: Server;
  url: string;
  requests: Json[];
}

let fake: Fake | undefined;
let dir: string | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (fake ? fake.server.close(() => done()) : done()));
  fake = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Greets when no tools are offered (the greeting), and takes the goodbye Edge when they are. */
async function startFakeApi(): Promise<Fake> {
  const requests: Json[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Json;
      requests.push(body);
      const events = body.tools
        ? [messageStart, ...toolBlock(0, "transition__e_start_goodbye", '{"reason":"done"}'), ...finish("tool_use")]
        : [messageStart, ...textBlock(0, ...GREETING_WORDS), ...finish("end_turn")];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sseBody(events));
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, requests };
}

function runProgram(input: string, extraEnv: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), "receptionist-chat-"));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("src/adapters/cli.ts")], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", ...extraEnv },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  child.stdin.end(input);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
    child.on("close", (code) => done({ code, stdout, stderr })),
  );
}

describe("the chat program", () => {
  it("greets first, and exits with the closing message when the Caller says goodbye", async () => {
    fake = await startFakeApi();

    const result = await runProgram("bye for now\n", { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: fake.url });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "Ava: Hello, this is Ava from Acme Co.\nYou: bye for now\nAva: Thank you for calling. Goodbye.\n",
    );
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]).toMatchObject({ model: "claude-sonnet-5-5", thinking: { type: "adaptive" }, fallbacks: "default" });
  });

  it("exits cleanly when the input closes before goodbye", async () => {
    fake = await startFakeApi();

    const result = await runProgram("", { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: fake.url });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Ava: Hello, this is Ava from Acme Co.\nYou: \n");
  });

  it("reports an API failure on opening the Call and exits non-zero", async () => {
    fake = await startFakeApi();
    fake.server.removeAllListeners("request");
    fake.server.on("request", (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    });

    const result = await runProgram("hello\n", { ANTHROPIC_API_KEY: "wrong", ANTHROPIC_BASE_URL: fake.url });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Could not open the Call");
    expect(result.stdout).toContain("invalid x-api-key");
  });
});
