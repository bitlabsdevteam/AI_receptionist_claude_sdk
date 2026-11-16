import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Runs the real wizard, `bash scripts/telnyx-setup.sh`, in a throwaway directory with nothing real behind it: a local
 * HTTP server stands in for the Telnyx API (`TELNYX_BASE_URL`), and the PATH holds stand-ins for `ngrok` and for the
 * commands that open a browser. No account is touched, no browser opens and no tunnel starts. It proves what the wizard
 * writes, prints and asks Telnyx, and nothing about the live portal or the live API.
 *
 * Every test has a directory, a stand-in Telnyx and a PATH of its own, so the tests run side by side.
 */

vi.setConfig({ testTimeout: 30_000 });

const WIZARD = resolve("scripts/telnyx-setup.sh");

const API_KEY = "KEY0123456789abcdef_TELNYX_secret";
const REJECTED_KEY = "KEY_that_telnyx_rejects_0000";
/** 32 bytes in Base64, the form the portal shows the account's public key in. */
const PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64");
const NGROK_TOKEN = "2abcNGROKtokenSECRET_9z";
const PUBLIC_BASE_URL = "https://quiet-otter.ngrok-free.dev";
const WEBHOOK_URL = `${PUBLIC_BASE_URL}/telnyx/webhooks`;
const OWN_NUMBER = "+14155550142";
const TELNYX_NUMBER = "+19705550198";
const APP_ID = "1293384261075731499";

/** What must never be shown, or kept anywhere but .env: the keys, ngrok's auth token and every full phone number. */
const SECRETS = [API_KEY, REJECTED_KEY, PUBLIC_KEY, NGROK_TOKEN, OWN_NUMBER, TELNYX_NUMBER];

const shownSecrets = (text: string): string[] => SECRETS.filter((secret) => text.includes(secret));

type Json = Record<string, unknown>;

const application = (changes: Json = {}): Json => ({
  id: APP_ID,
  record_type: "call_control_application",
  application_name: "receptionist",
  active: true,
  webhook_api_version: "2",
  webhook_event_url: WEBHOOK_URL,
  ...changes,
});

const phoneNumber = (changes: Json = {}): Json => ({
  id: "2293384261075731400",
  record_type: "phone_number",
  phone_number: TELNYX_NUMBER,
  country_iso_alpha2: "US",
  phone_number_type: "local",
  status: "active",
  connection_id: APP_ID,
  ...changes,
});

/**
 * A Telnyx account as the wizard reads it. Each list is given as the answers to successive requests, and the last one
 * repeats: `[[], [application()]]` is an account whose application appears after the first look, which is what the
 * person creating it in the portal looks like from here.
 */
interface Account {
  applications: Json[][];
  numbers: Json[][];
  /** The account's available credit, `5.00` unless given. */
  credit?: string;
}

/** An account that gains its application and its number while the wizard waits, as the person works in the portal. */
const newAccount: Account = { applications: [[], [application()]], numbers: [[], [phoneNumber()]] };

/** An account where everything is already in place in the portal. */
const readyAccount: Account = { applications: [[application()]], numbers: [[phoneNumber()]] };

/** What a first run is asked, in order, on `newAccount`. */
const FIRST_RUN = [
  "", // Ready to start?
  "trial", // the account level the portal shows
  API_KEY,
  PUBLIC_KEY,
  PUBLIC_BASE_URL,
  "", // the Voice API application has been created
  "", // the number has been bought and assigned
  OWN_NUMBER,
];

/** In `runInTerminal`, what to type for the interrupt key rather than a line. */
const CTRL_C = "\u0003";

const STEPS = ["Account", "API key and public key", "ngrok", "Voice API application", "Number", "Allowed Callers"];
const ALL_DONE = ["done", "done", "done", "done", "done", "done"];

interface Run {
  code: number | null;
  /** Everything the wizard printed, stdout and stderr together. */
  output: string;
}

/** How each step ended, read from the wizard's closing report: `done`, `skipped` or `failed`, in step order. */
function reported(run: Run): string[] {
  const report = run.output.slice(run.output.lastIndexOf("Telnyx setup"));
  return STEPS.map((name, index) => new RegExp(`${index + 1}\\. ${name}: (\\w+)\\.`).exec(report)?.[1] ?? "not reported");
}

/** Every file under `root`, however deep. */
function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
}

/** One test's world: the directory the wizard runs in, its stand-ins, and what they saw. */
interface Setup {
  /** The directory the wizard is run in, where `.env` belongs. */
  cwd: string;
  envFile: string;
  /** Where the stand-in ngrok keeps its auth token. Undefined when ngrok is not installed. */
  ngrokConfig: string | undefined;
  /** The stand-in Telnyx's address, and every request the wizard made to it. */
  telnyxUrl: string;
  requests: Array<{ method: string; path: string }>;
  /** Stops the stand-in Telnyx, so that the wizard finds nobody at its address. */
  stopTelnyx(): Promise<void>;
  /** Runs the wizard with `answers` as what the person types, one line each, in the order the wizard asks. */
  run(answers: string[], extraEnv?: Record<string, string>): Promise<Run>;
  /** Runs the wizard in a real terminal, typing each answer once the text before it is on screen. */
  runInTerminal(typed: Array<{ after: string; type: string }>): Promise<Run>;
  /** The variables in `.env`. */
  stored(): Record<string, string | undefined>;
  /** Writes a `.env` as a finished run leaves it, at an account level where the wizard has nothing left to ask. */
  writeFinishedEnv(changes?: Record<string, string>): void;
  /** The addresses the wizard opened in the browser. */
  opened(): string[];
  /** How ngrok was called, one entry per call. */
  ngrokCalls(): string[];
  /** The temp directory the wizard is given (`TMPDIR`), and every `mktemp` call it made, arguments included. */
  tempDir: string;
  tempFilesAskedFor(): string[];
  /** The files that hold a secret, among everything in the wizard's working, home and temp directories. */
  filesHoldingSecrets(): string[];
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/**
 * Builds a test's world. `ngrok` is the stand-in ngrok: `false` when it is not installed; otherwise its configuration
 * file holds an auth token, as `ngrok config add-authtoken` leaves it, unless `authToken` is false, and with `urlFlag`
 * false it is an older ngrok, whose flag for a fixed address is `--domain`.
 */
async function setUp(account: Account, ngrok: false | { authToken?: boolean; urlFlag?: boolean } = {}): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), "receptionist-wizard-"));
  const bin = join(dir, "bin");
  const cwd = join(dir, "cwd");
  const home = join(dir, "home");
  const tempDir = join(dir, "tmp");
  for (const made of [bin, cwd, home, tempDir]) mkdirSync(made);
  const envFile = join(cwd, ".env");

  const standIn = (name: string, script: string): void => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const logged = (name: string): string[] => {
    const path = join(dir, name);
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
  };

  // The wizard parses Telnyx's answers with node, which is not on the short PATH below.
  symlinkSync(process.execPath, join(bin, "node"));
  // Whatever the platform would open a browser with records the address instead.
  for (const opener of ["open", "xdg-open", "wslview", "explorer.exe"]) standIn(opener, `echo "$1" >> "${join(dir, "opened.log")}"`);
  // The real mktemp, with a record of where each temporary file was asked for.
  standIn(
    "mktemp",
    `echo "mktemp $*" >> "${join(dir, "mktemp.log")}"\nfor real in /usr/bin/mktemp /bin/mktemp; do [ -x "$real" ] && exec "$real" "$@"; done`,
  );

  // A stand-in for ngrok that starts nothing: it records how it was called and answers the wizard's two questions.
  let ngrokConfig: string | undefined;
  if (ngrok) {
    ngrokConfig = join(home, "ngrok.yml");
    writeFileSync(ngrokConfig, ngrok.authToken === false ? `version: "3"\n` : `version: "3"\nagent:\n    authtoken: ${NGROK_TOKEN}\n`);
    const flag = ngrok.urlFlag === false ? "--domain string   host tunnel on a custom hostname" : "--url string   host endpoint on a URL";
    standIn(
      "ngrok",
      [
        `echo "$*" >> "${join(dir, "ngrok.log")}"`,
        `case "$*" in`,
        `  "config check") echo "Valid configuration file at ${ngrokConfig}" ;;`,
        `  "http --help") echo "      ${flag}" ;;`,
        `esac`,
      ].join("\n"),
    );
  }

  // The stand-in Telnyx accepts `API_KEY` alone, and only answers reads.
  const requests: Setup["requests"] = [];
  const applications = [...account.applications];
  const numbers = [...account.numbers];
  const next = (answers: Json[][]): Json[] => (answers.length > 1 ? answers.shift()! : (answers[0] ?? []));
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(req.url ?? "");
    requests.push({ method: req.method ?? "", path });
    const send = (status: number, body: Json): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      send(401, { errors: [{ code: "10009", title: "Authentication failed" }] });
    } else if (req.method !== "GET") {
      send(405, { errors: [{ title: "The stand-in only answers reads" }] });
    } else if (path === "/v2/balance") {
      send(200, { data: { record_type: "balance", balance: "5.00", available_credit: account.credit ?? "5.00", currency: "USD" } });
    } else if (path.startsWith("/v2/call_control_applications")) {
      send(200, { data: next(applications) });
    } else if (path.startsWith("/v2/phone_numbers")) {
      send(200, { data: next(numbers) });
    } else {
      send(404, { errors: [{ title: "Not found" }] });
    }
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const telnyxUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stopTelnyx = (): Promise<void> => new Promise<void>((stopped) => server.close(() => stopped()));
  cleanups.push(async () => {
    await stopTelnyx();
    rmSync(dir, { recursive: true, force: true });
  });

  // The stand-ins come first on a PATH with only the system's own tools after them, and the wizard is always pointed
  // at the stand-in Telnyx, so that it can never reach the real API.
  const wizardEnv = (extra: Record<string, string>): Record<string, string> => ({
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: tempDir,
    TELNYX_BASE_URL: telnyxUrl,
    ...extra,
  });
  const finished = (child: ReturnType<typeof spawn>): Promise<Run> => {
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    return new Promise<Run>((done) => child.on("close", (code) => done({ code, output })));
  };

  return {
    cwd,
    envFile,
    ngrokConfig,
    telnyxUrl,
    requests,
    stopTelnyx,
    run(answers, extraEnv = {}) {
      const child = spawn("bash", [WIZARD], { cwd, env: wizardEnv(extraEnv), timeout: 25_000 });
      child.stdin.end(answers.map((answer) => `${answer}\n`).join(""));
      return finished(child);
    },
    // `expect` gives the wizard a terminal. A terminal shows what is typed unless the program reading it turns that
    // off, so the transcript is what a person would see. The pipes `run` uses show nothing typed at all, and could not
    // tell a hidden answer from a visible one.
    runInTerminal(typed) {
      const script = join(dir, "terminal.exp");
      writeFileSync(
        script,
        [
          "set timeout 20",
          `spawn bash {${WIZARD}}`,
          // The pause lets the wizard start reading, so that no answer is typed ahead of its prompt's read.
          ...typed.flatMap((step) => [
            `expect -exact {${step.after}}`,
            "sleep 0.2",
            ...(step.type === CTRL_C ? ['send "\\003"'] : [`send -- {${step.type}}`, 'send "\\r"']),
          ]),
          "expect eof",
        ].join("\n"),
      );
      const child = spawn("expect", [script], { cwd, env: wizardEnv({ TERM: "xterm" }), timeout: 25_000 });
      child.stdin.end();
      return finished(child);
    },
    stored: () => parseEnv(readFileSync(envFile, "utf8")),
    writeFinishedEnv(changes = {}) {
      const values = {
        TELNYX_ACCOUNT_LEVEL: "verified",
        TELNYX_API_KEY: API_KEY,
        TELNYX_PUBLIC_KEY: PUBLIC_KEY,
        PUBLIC_BASE_URL,
        PHONE_ALLOWED_CALLERS: OWN_NUMBER,
        ...changes,
      };
      writeFileSync(envFile, Object.entries(values).map(([name, value]) => `${name}='${value}'\n`).join(""));
    },
    opened: () => logged("opened.log"),
    ngrokCalls: () => logged("ngrok.log"),
    tempDir,
    tempFilesAskedFor: () => logged("mktemp.log"),
    filesHoldingSecrets: () =>
      ["cwd", "home", "tmp"]
        .flatMap((name) => filesUnder(join(dir, name)))
        .filter((path) => shownSecrets(readFileSync(path, "utf8")).length > 0)
        .sort(),
  };
}

describe.concurrent("the Telnyx setup wizard on a first run", () => {
  it("stores what the person gives it in .env and reports each of the six steps as done", async () => {
    const wizard = await setUp(newAccount);
    copyFileSync(resolve(".env.example"), wizard.envFile);

    const run = await wizard.run(FIRST_RUN);

    expect(reported(run)).toEqual(ALL_DONE);
    expect(run.code).toBe(0);
    expect(wizard.stored()).toMatchObject({
      TELNYX_API_KEY: API_KEY,
      TELNYX_PUBLIC_KEY: PUBLIC_KEY,
      PUBLIC_BASE_URL,
      PHONE_ALLOWED_CALLERS: OWN_NUMBER,
      TELNYX_ACCOUNT_LEVEL: "trial",
      // What was in the file before is still there.
      ANTHROPIC_API_KEY: "sk-ant-...",
    });
  });

  it("prints no key and no full phone number, and leaves them in no file but .env", async () => {
    const wizard = await setUp(newAccount);

    const run = await wizard.run(FIRST_RUN);

    expect(reported(run)).toEqual(ALL_DONE);
    expect(shownSecrets(run.output)).toEqual([]);
    // A phone number is shown by its last four digits: the Caller's own, and the one Telnyx lists for the application.
    expect(run.output).toContain("ending 0142");
    expect(run.output).toContain("ending 0198");
    // ngrok's own configuration is the one other file with a secret in it, and the wizard did not put it there.
    expect(wizard.filesHoldingSecrets()).toEqual([wizard.envFile, wizard.ngrokConfig].sort());
    expect(statSync(wizard.envFile).mode & 0o777).toBe(0o600);
    // Its working files, the passing copies of .env among them, were all made in the temp directory it was given,
    // which the search above covers, and none of them is left.
    expect(wizard.tempFilesAskedFor()).not.toEqual([]);
    expect(wizard.tempFilesAskedFor().filter((asked) => !asked.includes(wizard.tempDir))).toEqual([]);
    expect(readdirSync(wizard.tempDir)).toEqual([]);
  });

  it("only reads from Telnyx, opens only the portal and the ngrok dashboard, and never starts ngrok", async () => {
    const wizard = await setUp(newAccount);

    await wizard.run(FIRST_RUN);

    expect(wizard.requests.map((request) => request.method)).toEqual(["GET", "GET", "GET", "GET", "GET"]);
    expect(wizard.requests.map((request) => request.path.split("?")[0])).toEqual([
      "/v2/balance",
      "/v2/call_control_applications",
      "/v2/call_control_applications",
      "/v2/phone_numbers",
      "/v2/phone_numbers",
    ]);
    expect(wizard.opened()).not.toEqual([]);
    expect(wizard.opened().filter((url) => !/^https:\/\/(portal\.telnyx\.com|dashboard\.ngrok\.com)(\/|$)/.test(url))).toEqual([]);
    // Asking ngrok where its configuration is and which flags it has starts no tunnel.
    expect(wizard.ngrokCalls().filter((call) => call !== "config check" && call !== "http --help")).toEqual([]);
  });

  it("tells the person the command that opens the tunnel, with the flag their ngrok has", async () => {
    const wizard = await setUp(newAccount, { urlFlag: false });

    const run = await wizard.run(FIRST_RUN, { PORT: "8080" });

    expect(run.output).toContain("ngrok http 8080 --domain quiet-otter.ngrok-free.dev");
  });
});

describe.concurrent("the Telnyx setup wizard run again", () => {
  it("skips all six steps and changes nothing", async () => {
    const wizard = await setUp(newAccount);
    await wizard.run(FIRST_RUN);
    const before = { text: readFileSync(wizard.envFile, "utf8"), modified: statSync(wizard.envFile).mtimeMs, opened: wizard.opened().length };

    // Nobody answers: every step finds its work done.
    const again = await wizard.run([]);

    expect(reported(again)).toEqual(["skipped", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    expect(again.code).toBe(0);
    expect(readFileSync(wizard.envFile, "utf8")).toBe(before.text);
    expect(statSync(wizard.envFile).mtimeMs).toBe(before.modified);
    expect(wizard.opened()).toHaveLength(before.opened);
    expect(wizard.requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(shownSecrets(again.output)).toEqual([]);
    expect(wizard.filesHoldingSecrets()).toEqual([wizard.envFile, wizard.ngrokConfig].sort());
  });

  it("asks whether the account has moved up while its recorded level still has the abuse notice", async () => {
    const wizard = await setUp(readyAccount);
    wizard.writeFinishedEnv({ TELNYX_ACCOUNT_LEVEL: "paid" });

    const run = await wizard.run(["", "y", "verified"]);

    expect(run.output).toContain("Until the account is Verified, Telnyx speaks its abuse notice before machine speech");
    expect(reported(run)).toEqual(["done", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    expect(wizard.stored().TELNYX_ACCOUNT_LEVEL).toBe("verified");
  });
});

describe.concurrent("a value already in .env", () => {
  it("is kept when Telnyx rejects the stored key and the person does not agree to replace it", async () => {
    const wizard = await setUp(readyAccount);
    wizard.writeFinishedEnv({ TELNYX_API_KEY: REJECTED_KEY });
    const before = readFileSync(wizard.envFile, "utf8");

    const run = await wizard.run(["", "n"]);

    expect(run.output).toContain("Replace the TELNYX_API_KEY stored in .env?");
    expect(run.output).toContain(
      "2. API key and public key: failed. Telnyx does not accept the stored TELNYX_API_KEY (HTTP 401), and it was kept",
    );
    expect(run.code).toBe(1);
    expect(readFileSync(wizard.envFile, "utf8")).toBe(before);
    expect(shownSecrets(run.output)).toEqual([]);
  });

  it("is replaced once the person agrees", async () => {
    const wizard = await setUp(readyAccount);
    wizard.writeFinishedEnv({ TELNYX_API_KEY: REJECTED_KEY });

    const run = await wizard.run(["", "y", API_KEY]);

    expect(reported(run)).toEqual(["skipped", "done", "skipped", "skipped", "skipped", "skipped"]);
    expect(run.code).toBe(0);
    expect(wizard.stored().TELNYX_API_KEY).toBe(API_KEY);
    expect(readFileSync(wizard.envFile, "utf8")).not.toContain(REJECTED_KEY);
  });

  it("is kept when it is not a usable address and the person does not agree to replace it", async () => {
    const wizard = await setUp(readyAccount);
    wizard.writeFinishedEnv({ PUBLIC_BASE_URL: "http://plain.example.com/path" });
    const before = readFileSync(wizard.envFile, "utf8");

    const run = await wizard.run(["", "n"]);

    expect(run.output).toContain("Replace the PUBLIC_BASE_URL stored in .env?");
    expect(reported(run)).toEqual(["skipped", "skipped", "failed", "failed", "failed", "skipped"]);
    expect(readFileSync(wizard.envFile, "utf8")).toBe(before);
  });

  it("is asked about even when it is written in a way the wizard cannot read", async () => {
    const wizard = await setUp(readyAccount);
    wizard.writeFinishedEnv();
    // An escaped double-quoted value: the wizard does not decode it, so it asks for the address as if there were none.
    const unreadable = 'PUBLIC_BASE_URL="https://old.example.com\\"x"\n';
    writeFileSync(wizard.envFile, readFileSync(wizard.envFile, "utf8").replace(/^PUBLIC_BASE_URL=.*\n/m, unreadable));
    const before = readFileSync(wizard.envFile, "utf8");

    const run = await wizard.run(["", PUBLIC_BASE_URL, "n"]);

    expect(run.output).toContain("Replace the PUBLIC_BASE_URL stored in .env?");
    expect(run.output).toContain("3. ngrok: failed. the PUBLIC_BASE_URL stored before was kept");
    expect(readFileSync(wizard.envFile, "utf8")).toBe(before);
  });
});

describe.concurrent("what the wizard checks without spending money", () => {
  it("gives up on a key Telnyx rejects after three tries and stores nothing", async () => {
    const wizard = await setUp(newAccount);

    const run = await wizard.run(["", "trial", REJECTED_KEY, REJECTED_KEY, REJECTED_KEY]);

    expect(run.output).toContain("2. API key and public key: failed. Telnyx did not accept the API key in three tries");
    expect(run.code).toBe(1);
    expect(wizard.stored().TELNYX_API_KEY).toBeUndefined();
    expect(shownSecrets(run.output)).toEqual([]);
    expect(wizard.filesHoldingSecrets()).toEqual([wizard.ngrokConfig]);
  });

  it("keeps a new key it could not try, since Telnyx shows it once, and fails the step", async () => {
    const wizard = await setUp(newAccount);
    await wizard.stopTelnyx();

    const run = await wizard.run(["", "trial", API_KEY]);

    expect(run.output).toContain(
      `2. API key and public key: failed. the API key is stored but could not be checked: Telnyx could not be reached at ${wizard.telnyxUrl}`,
    );
    expect(run.code).toBe(1);
    expect(wizard.stored().TELNYX_API_KEY).toBe(API_KEY);
    expect(shownSecrets(run.output)).toEqual([]);
  });

  it("warns when the account has no funds to buy a number with", async () => {
    const wizard = await setUp({ ...newAccount, credit: "0.00" });

    const run = await wizard.run(FIRST_RUN);

    expect(run.output).toContain("The account's available credit is not above zero: add funds before buying a number.");
  });

  it("refuses what is not Telnyx's public key, without repeating it", async () => {
    const wizard = await setUp(newAccount);

    const run = await wizard.run(["", "trial", API_KEY, "not-a-public-key"]);

    expect(run.output).toContain("2. API key and public key: failed. what was pasted is not the public key");
    expect(wizard.stored().TELNYX_PUBLIC_KEY).toBeUndefined();
    expect(run.output).not.toContain("not-a-public-key");
  });

  it("names the webhook version of an application that is not on version 2", async () => {
    const wizard = await setUp({ applications: [[application({ webhook_api_version: "1" })]], numbers: [[phoneNumber()]] });
    wizard.writeFinishedEnv();

    const run = await wizard.run(["", ""]);

    expect(run.output).toContain(
      `4. Voice API application: failed. the application with the Webhook URL ${WEBHOOK_URL} is not ready: its Webhook API version is 1, not 2`,
    );
    expect(run.output).toContain("5. Number: failed. it needs the Voice API application (step 4)");
    expect(run.code).toBe(1);
  });

  it("says when no application has the webhook address", async () => {
    const elsewhere = application({ webhook_event_url: "https://elsewhere.example.com/hooks" });
    const wizard = await setUp({ applications: [[elsewhere]], numbers: [[phoneNumber()]] });
    wizard.writeFinishedEnv();

    const run = await wizard.run(["", ""]);

    expect(run.output).toContain(
      `4. Voice API application: failed. none of the account's 1 application(s) has the Webhook URL ${WEBHOOK_URL}`,
    );
  });

  it("says when the account's number is not assigned to the application", async () => {
    const wizard = await setUp({ applications: [[application()]], numbers: [[phoneNumber({ connection_id: null })]] });
    wizard.writeFinishedEnv();

    const run = await wizard.run(["", ""]);

    expect(run.output).toContain("5. Number: failed. the account has 1 number(s), but none is assigned to the application");
    expect(reported(run)).toEqual(["skipped", "skipped", "skipped", "skipped", "failed", "skipped"]);
    expect(run.code).toBe(1);
  });

  it("names the status of an assigned number that is not active yet, by its last four digits", async () => {
    const wizard = await setUp({ applications: [[application()]], numbers: [[phoneNumber({ status: "purchase-pending" })]] });
    wizard.writeFinishedEnv();

    const run = await wizard.run(["", ""]);

    expect(run.output).toContain(
      "5. Number: failed. the number ending 0198 is assigned to the application, but its status is purchase-pending, not active",
    );
    expect(shownSecrets(run.output)).toEqual([]);
  });

  it("refuses a phone number that is not in E.164 form, without repeating it", async () => {
    const wizard = await setUp(readyAccount);
    wizard.writeFinishedEnv();
    writeFileSync(wizard.envFile, readFileSync(wizard.envFile, "utf8").replace(/^PHONE_ALLOWED_CALLERS=.*\n/m, ""));

    const run = await wizard.run(["", "(415) 555-0142"]);

    expect(run.output).toContain("6. Allowed Callers: failed. that is not a phone number in E.164 form");
    expect(run.output).not.toContain("555-0142");
    expect(wizard.stored().PHONE_ALLOWED_CALLERS).toBeUndefined();
  });
});

describe.concurrent("the ngrok step", () => {
  it("fails when ngrok is not installed, and the other steps still run", async () => {
    const wizard = await setUp(readyAccount, false);
    wizard.writeFinishedEnv();

    const run = await wizard.run([]);

    expect(run.output).toContain("3. ngrok: failed. ngrok is not installed");
    expect(reported(run)).toEqual(["skipped", "skipped", "failed", "skipped", "skipped", "skipped"]);
    expect(run.code).toBe(1);
  });

  it("fails when ngrok has no auth token after the person was shown how to give it one", async () => {
    const wizard = await setUp(readyAccount, { authToken: false });
    wizard.writeFinishedEnv();

    const run = await wizard.run(["", ""]);

    expect(wizard.opened()).toEqual(["https://dashboard.ngrok.com/get-started/your-authtoken"]);
    expect(run.output).toContain("3. ngrok: failed. ngrok has no auth token");
    expect(run.code).toBe(1);
  });
});

describe.concurrent("before the wizard asks for anything", () => {
  it("stops when git would commit the file the keys go in", async () => {
    const wizard = await setUp(newAccount);
    spawnSync("git", ["init", "-q"], { cwd: wizard.cwd });

    const run = await wizard.run(FIRST_RUN);

    expect(run.output).toContain(".env is in a git repository and is not git-ignored");
    expect(run.code).toBe(1);
    expect(existsSync(wizard.envFile)).toBe(false);
    expect(wizard.requests).toEqual([]);
  });

  it("goes ahead in a git repository that ignores the file", async () => {
    const wizard = await setUp(newAccount);
    spawnSync("git", ["init", "-q"], { cwd: wizard.cwd });
    writeFileSync(join(wizard.cwd, ".gitignore"), ".env\n");

    const run = await wizard.run(FIRST_RUN);

    expect(reported(run)).toEqual(ALL_DONE);
  });

  it("stops rather than send a key to an address that is neither https nor this machine", async () => {
    const wizard = await setUp(newAccount);

    const run = await wizard.run(FIRST_RUN, { TELNYX_BASE_URL: "http://api.example.com" });

    expect(run.output).toContain("TELNYX_BASE_URL must be an https:// address");
    expect(run.code).toBe(1);
    expect(existsSync(wizard.envFile)).toBe(false);
  });
});

const hasExpect = spawnSync("expect", ["-v"]).status === 0;

describe.concurrent("the Telnyx setup wizard in a terminal", () => {
  it.skipIf(!hasExpect)("does not show the keys or the phone number as they are typed", async () => {
    const wizard = await setUp(newAccount);

    const run = await wizard.runInTerminal([
      { after: "Ready to start?", type: "" },
      { after: "Which level does the portal show", type: "trial" },
      { after: "Paste the API key (input is hidden):", type: API_KEY },
      { after: "Paste the public key (input is hidden):", type: PUBLIC_KEY },
      { after: "The public address", type: PUBLIC_BASE_URL },
      { after: "Press Enter when the application is saved", type: "" },
      { after: "Press Enter when the number is assigned to the application", type: "" },
      { after: "Your number (input is hidden):", type: OWN_NUMBER },
    ]);

    // The terminal does show an answer that is not a secret, on the line of its prompt.
    expect(run.output).toMatch(/Which level does the portal show[^\n]*trial/);
    expect(shownSecrets(run.output)).toEqual([]);
    expect(wizard.stored()).toMatchObject({ TELNYX_API_KEY: API_KEY, TELNYX_PUBLIC_KEY: PUBLIC_KEY, PHONE_ALLOWED_CALLERS: OWN_NUMBER });
    expect(reported(run)).toEqual(ALL_DONE);
  });

  it.skipIf(!hasExpect)("stops at Ctrl-C on a hidden prompt, keeping what was stored and leaving no working file", async () => {
    const wizard = await setUp(newAccount);

    const run = await wizard.runInTerminal([
      { after: "Ready to start?", type: "" },
      { after: "Which level does the portal show", type: "trial" },
      { after: "Paste the API key (input is hidden):", type: API_KEY },
      { after: "Paste the public key (input is hidden):", type: CTRL_C },
    ]);

    expect(run.output).not.toContain("Stage 3/6");
    expect(wizard.stored()).toEqual({ TELNYX_ACCOUNT_LEVEL: "trial", TELNYX_API_KEY: API_KEY });
    expect(readdirSync(wizard.tempDir)).toEqual([]);
    expect(shownSecrets(run.output)).toEqual([]);
  });
});

describe(".env.example", () => {
  const example = parseEnv(readFileSync(".env.example", "utf8"));

  it("lists every variable of the phone Channel, with no value filled in", () => {
    expect(example).toMatchObject({
      TELNYX_API_KEY: "",
      TELNYX_PUBLIC_KEY: "",
      PUBLIC_BASE_URL: "",
      PHONE_ALLOWED_CALLERS: "",
      TELNYX_TTS_VOICE: "",
      TELNYX_STT_ENGINE: "",
      TELNYX_STT_MODEL: "",
      VOICE_LANGUAGE: "",
      PORT: "",
      TELNYX_BASE_URL: "",
      TELNYX_ACCOUNT_LEVEL: "",
    });
  });
});
