import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transitionToolName } from "../src/engine/run-node.js";
import { finish, messageStart, sseBody, textBlock, toolBlock, type Json } from "./sse.js";
import { wavClip } from "./wav.js";

/**
 * Runs the real program, as `npm run talk` does, with nothing real behind it: one throwaway HTTP server stands in for
 * Anthropic and ElevenLabs, and the program's PATH holds only stand-ins for `afplay` and `ffmpeg`, so no sound is
 * played and no microphone is opened. It proves the wiring (env, Flow, engine, Voice, recorder, readline, exit codes)
 * and nothing about the live services.
 */

const GREETING_WORDS = ["Hello,", " this", " is", " Ava", " from", " Acme", " Co."];
const GREETING = GREETING_WORDS.join("");
const MP3 = "ID3 pretend mp3";
const PROMPT = "You (Enter to speak, or type): ";
const RECORDING = "(Recording. Press Enter to stop.) ";

interface Fake {
  server: Server;
  url: string;
  /** Bodies of the requests to the model. */
  model: Json[];
  /** Bodies of the text-to-speech requests, and the key each came with. */
  speech: Array<{ path: string; key: string | undefined; body: Json }>;
  /** The speech-to-text uploads, raw, and the key each came with. */
  uploads: Array<{ key: string | undefined; body: Buffer }>;
}

let fake: Fake | undefined;
let dir: string;
let bin: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "receptionist-talk-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
});
afterEach(async () => {
  await new Promise<void>((done) => (fake ? fake.server.close(() => done()) : done()));
  fake = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The model greets when no tools are offered and takes the goodbye Edge when they are. Text-to-speech answers with
 * pretend mp3 bytes, and speech-to-text with `heard` as the transcript.
 */
async function startFakeServices(heard = ""): Promise<Fake> {
  const services: Omit<Fake, "server" | "url"> = { model: [], speech: [], uploads: [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const path = req.url ?? "";
      const key = req.headers["xi-api-key"] as string | undefined;
      if (path.startsWith("/v1/text-to-speech/")) {
        services.speech.push({ path, key, body: JSON.parse(raw.toString()) as Json });
        res.writeHead(200, { "content-type": "audio/mpeg" });
        res.end(MP3);
      } else if (path.startsWith("/v1/speech-to-text")) {
        services.uploads.push({ key, body: raw });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ language_code: "eng", text: heard }));
      } else {
        const body = JSON.parse(raw.toString()) as Json;
        services.model.push(body);
        const events = body.tools
          ? [messageStart, ...toolBlock(0, transitionToolName({ id: "e_start_goodbye" }), '{"reason":"done"}'), ...finish("tool_use")]
          : [messageStart, ...textBlock(0, ...GREETING_WORDS), ...finish("end_turn")];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseBody(events));
      }
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, ...services };
}

function standIn(name: string, script: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

/** A stand-in for `afplay` that plays nothing: it appends the file it was asked to play to `played.log`. */
function fakeAfplay(): () => string {
  const log = join(dir, "played.log");
  standIn("afplay", `/bin/cat "$1" >> "${log}"\necho >> "${log}"`);
  return () => (existsSync(log) ? readFileSync(log, "utf8") : "");
}

/** A stand-in for `ffmpeg` that records nothing: once told to stop, it writes a canned clip to its output path. */
function fakeFfmpeg(clip: Uint8Array): void {
  const source = join(dir, "canned.wav");
  writeFileSync(source, clip);
  standIn("ffmpeg", `for out; do :; done\n/bin/cat > /dev/null\n/bin/cp "${source}" "$out"`);
}

function servicesEnv(services: Fake): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: "test-key",
    ANTHROPIC_BASE_URL: services.url,
    ELEVENLABS_API_KEY: "eleven-test-key",
    ELEVENLABS_VOICE_ID: "voice-1",
    ELEVENLABS_BASE_URL: services.url,
  };
}

/** What the Caller types: all at once, or a line at a time, each once the program has printed `after`. */
type Typed = string | Array<{ after: string; type: string }>;

function runProgram(input: Typed, extraEnv: Record<string, string>) {
  const cwd = join(dir, "cwd");
  mkdirSync(cwd);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("src/adapters/talk-cli.ts")], {
    cwd,
    // Only the stand-ins are on the PATH, so the real afplay and ffmpeg cannot be started.
    env: { PATH: bin, ...extraEnv },
    timeout: 20_000,
  });
  let stdout = "";
  let stderr = "";
  const steps = typeof input === "string" ? [] : [...input];
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
    while (steps[0] && stdout.includes(steps[0].after)) child.stdin.write(steps.shift()!.type);
    if (typeof input !== "string" && steps.length === 0) child.stdin.end();
  });
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  if (typeof input === "string") child.stdin.end(input);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
    child.on("close", (code) => done({ code, stdout, stderr })),
  );
}

describe("the talk program at startup", () => {
  it("names every missing variable and exits 1 before anything is sent, played or recorded", async () => {
    const played = fakeAfplay();

    const result = await runProgram("", {});

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY is not set");
    expect(result.stderr).toContain("ELEVENLABS_API_KEY is not set");
    expect(result.stderr).toContain("ELEVENLABS_VOICE_ID is not set");
    expect(result.stdout).toBe("");
    expect(played()).toBe("");
  });

  it("names the one variable that is missing", async () => {
    fake = await startFakeServices();
    const { ELEVENLABS_VOICE_ID: _missing, ...env } = servicesEnv(fake);

    const result = await runProgram("", env);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      "ELEVENLABS_VOICE_ID is not set. Put the id of the ElevenLabs voice to speak with in .env, " +
        "or export ELEVENLABS_VOICE_ID in your shell.\n",
    );
    expect(result.stdout).toBe("");
    expect(fake.model).toHaveLength(0);
  });
});

describe("the talk program", () => {
  it("speaks the greeting, takes a typed line, speaks the closing message and prints the Turn's timing", async () => {
    fake = await startFakeServices();
    const played = fakeAfplay();

    const result = await runProgram("bye for now\n", servicesEnv(fake));

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const [before, timing, after] = result.stdout.split(/(\(Timing: model \d+ ms, speak \d+ ms\)\n)/);
    expect(before).toBe(`Ava: ${GREETING}\n${PROMPT}bye for now\nAva: Thank you for calling. Goodbye.\n`);
    expect(timing).toBeDefined();
    expect(after).toBe("");
    expect(fake.speech.map((request) => request.body.text)).toEqual([GREETING, "Thank you for calling. Goodbye."]);
    expect(fake.speech.map((request) => request.key)).toEqual(["eleven-test-key", "eleven-test-key"]);
    expect(fake.speech[0]?.path).toContain("/v1/text-to-speech/voice-1");
    expect(played()).toBe(`${MP3}\n${MP3}\n`);
    expect(fake.uploads).toHaveLength(0);
  });

  it("records on Enter until Enter, sends what was heard to the model, and times recording and transcribing apart", async () => {
    fake = await startFakeServices("Goodbye, thanks.");
    fakeAfplay();
    const clip = wavClip(500);
    fakeFfmpeg(clip);

    const result = await runProgram("\n\n", servicesEnv(fake));

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const [before, timing, after] = result.stdout.split(/(\(Timing: record \d+ ms, transcribe \d+ ms, model \d+ ms, speak \d+ ms\)\n)/);
    expect(before).toBe(
      `Ava: ${GREETING}\n${PROMPT}\n${RECORDING}\nYou: Goodbye, thanks.\nAva: Thank you for calling. Goodbye.\n`,
    );
    expect(timing).toBeDefined();
    expect(after).toBe("");
    expect(fake.uploads).toHaveLength(1);
    expect(fake.uploads[0]?.key).toBe("eleven-test-key");
    expect(fake.uploads[0]?.body.includes(Buffer.from(clip))).toBe(true);
    expect(JSON.stringify(fake.model[1]?.messages)).toContain("Goodbye, thanks.");
  });

  it("honours FLOW_PATH", async () => {
    fake = await startFakeServices();
    fakeAfplay();
    const flow = JSON.parse(readFileSync("flows/receptionist.json", "utf8")) as { variables: Record<string, string> };
    flow.variables.receptionist_name = "Bo";
    const flowPath = join(dir, "other-flow.json");
    writeFileSync(flowPath, JSON.stringify(flow));

    const result = await runProgram("", { ...servicesEnv(fake), FLOW_PATH: flowPath });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Bo: ${GREETING}\n${PROMPT}\n`);
  });

  it("carries on in text when the reply cannot be played", async () => {
    fake = await startFakeServices();
    // No afplay stand-in on the PATH, so playing fails.

    const result = await runProgram("bye for now\n", servicesEnv(fake));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Ava: ${GREETING}\n(Could not speak: `);
    expect(result.stdout).toContain("Ava: Thank you for calling. Goodbye.\n");
  });

  it("does not let a recording that failed swallow the Caller's next line", async () => {
    fake = await startFakeServices();
    fakeAfplay();
    // No ffmpeg stand-in on the PATH, so the recorder dies at once while the program waits for Enter.

    const result = await runProgram(
      [
        { after: PROMPT, type: "\n" },
        { after: "Please try again.)\n", type: "bye for now\n" },
      ],
      servicesEnv(fake),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${RECORDING}\n(Could not hear you: Recording needs ffmpeg`);
    expect(result.stdout).toContain(`${PROMPT}bye for now\nAva: Thank you for calling. Goodbye.\n`);
    expect(JSON.stringify(fake.model[1]?.messages)).toContain("bye for now");
  });
});
