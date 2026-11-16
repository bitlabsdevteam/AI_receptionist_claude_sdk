import { randomUUID } from "node:crypto";
import { isObject, text } from "./fields.js";

/**
 * The commands a phone Call sends to Telnyx (Call Control, `POST /v2/calls/{call_control_id}/actions/{command}`), over
 * an injected `fetch`. Six commands: `answer`, `reject`, `hangup`, `speak`, `conversation_relay_start` and
 * `conversation_relay_stop`. Nothing here knows a Call's rules: it says what to send and what went wrong.
 *
 * Every command carries a `command_id`, so that Telnyx ignores a repeat of it for the same call. A command is sent
 * once: when it fails, the caller retries with the same `commandId`, and a retry that got through the first time is
 * harmless. Every request has a time limit.
 *
 * The API key is sent in the `Authorization` header and nowhere else, and is removed from everything an error says,
 * its `cause` included.
 */

export const DEFAULT_TELNYX_BASE_URL = "https://api.telnyx.com";

/**
 * Telnyx's command retry guidance is to resend after 500 ms without an answer. A command that is slower than this
 * is given up on and left to the caller, who can resend it with the same command id.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** What Telnyx's `speak` lists for its `language`. The Relay's `en` is not among them. */
const SPEAK_LANGUAGES: ReadonlySet<string> = new Set([
  "arb", "cmn-CN", "cy-GB", "da-DK", "de-DE", "en-AU", "en-GB", "en-GB-WLS", "en-IN", "en-US", "es-ES", "es-MX", "es-US", "fr-CA", "fr-FR",
  "hi-IN", "is-IS", "it-IT", "ja-JP", "ko-KR", "nb-NO", "nl-NL", "pl-PL", "pt-BR", "pt-PT", "ro-RO", "ru-RU", "sv-SE", "tr-TR",
]);

/**
 * `language` as `speak` takes it, or undefined when `speak` does not list it. The Relay and `speak` spell languages
 * differently (`en` and `en-US`), so one setting cannot be sent to both as it is. Sending an unlisted one is a 422.
 */
export function speakLanguage(language: string | undefined): string | undefined {
  return language !== undefined && SPEAK_LANGUAGES.has(language) ? language : undefined;
}

export type TelnyxCommand = "answer" | "reject" | "hangup" | "speak" | "conversation_relay_start" | "conversation_relay_stop";

interface TelnyxErrorDetails {
  command?: TelnyxCommand;
  /** The HTTP status. Undefined when no response came. */
  status?: number;
  /** Telnyx's error `code`, such as `90018`, as text. */
  code?: string;
  /** Telnyx's longer explanation. */
  detail?: string;
  cause?: Error;
}

/** A command Telnyx did not accept, could not be reached for, or did not answer in time. Holds no key. */
export class TelnyxError extends Error {
  readonly command: TelnyxCommand | undefined;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly detail: string | undefined;

  constructor(message: string, details: TelnyxErrorDetails = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "TelnyxError";
    this.command = details.command;
    this.status = details.status;
    this.code = details.code;
    this.detail = details.detail;
  }
}

export interface TelnyxClientConfig {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Defaults to `https://api.telnyx.com`. Must be https, or http to this machine (a stand-in for tests). */
  baseUrl?: string;
  /** How long a request, and the reading of an error's body, may take. */
  timeoutMs?: number;
}

/** Options every command takes. */
export interface CommandOptions {
  /** A repeat of the same id for the same call is ignored by Telnyx. Defaults to a new UUID. */
  commandId?: string;
}

export interface RejectOptions extends CommandOptions {
  /** The SIP answer. Defaults to `CALL_REJECTED` (603 Decline). */
  cause?: "CALL_REJECTED" | "NOT_FOUND" | "TEMPORARILY_UNAVAILABLE" | "USER_BUSY";
}

export interface SpeakOptions extends CommandOptions {
  /** What to say. Telnyx allows 3,000 characters. */
  text: string;
  /** In Telnyx's form `<Provider>.<Model>.<VoiceId>`, such as `Telnyx.Ultra.Callie`. */
  voice: string;
  /** Sent only if `speak` lists it (see `speakLanguage`). */
  language?: string;
}

export interface StartRelayOptions extends CommandOptions {
  /** The `wss://` address Telnyx connects to. */
  url: string;
  voice: string;
  /** The speech recognition engine, such as `Deepgram`. Telnyx's default when absent. */
  sttEngine?: string;
  /** The engine's model, such as `deepgram/nova-3`. */
  sttModel?: string;
  /** For both the voice and the speech recognition, in the Relay's form, such as `en`. */
  language?: string;
}

/** Hosts that stand in for Telnyx on this machine, where http is allowed. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

function checkedBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let url: URL | undefined;
  try {
    url = new URL(trimmed);
  } catch {
    url = undefined;
  }
  const allowed = url !== undefined && (url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)));
  if (!allowed) throw new TelnyxError("TELNYX_BASE_URL must be an https:// address, or an http:// one on this machine.");
  return trimmed;
}

/** The call's id in a path as Telnyx writes it (`v3:...`): a colon stays, anything that could change the path is escaped. */
function pathSegment(id: string): string {
  return encodeURIComponent(id).replaceAll("%3A", ":");
}

export class TelnyxClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(config: TelnyxClientConfig) {
    const apiKey = config.apiKey.trim();
    if (apiKey === "") throw new TelnyxError("TELNYX_API_KEY is not set.");
    this.#apiKey = apiKey;
    this.#baseUrl = checkedBaseUrl(config.baseUrl ?? DEFAULT_TELNYX_BASE_URL);
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The client for `TELNYX_API_KEY` and `TELNYX_BASE_URL` (blank means the default). */
  static fromEnv(env: Record<string, string | undefined>, extra: Pick<TelnyxClientConfig, "fetch" | "timeoutMs"> = {}): TelnyxClient {
    const baseUrl = env.TELNYX_BASE_URL?.trim();
    return new TelnyxClient({ apiKey: env.TELNYX_API_KEY ?? "", baseUrl: baseUrl ? baseUrl : undefined, ...extra });
  }

  /** Answers an incoming call. Its commands wait for this. */
  answer(callControlId: string, options: CommandOptions = {}): Promise<void> {
    return this.#send("answer", callControlId, {}, options);
  }

  /** Declines an incoming call without answering it. */
  reject(callControlId: string, options: RejectOptions = {}): Promise<void> {
    return this.#send("reject", callControlId, { cause: options.cause ?? "CALL_REJECTED" }, options);
  }

  hangup(callControlId: string, options: CommandOptions = {}): Promise<void> {
    return this.#send("hangup", callControlId, {}, options);
  }

  /** Has Telnyx say `text` on the call. `call.speak.ended` says when it has finished. */
  speak(callControlId: string, options: SpeakOptions): Promise<void> {
    const language = speakLanguage(options.language);
    return this.#send(
      "speak",
      callControlId,
      { payload: options.text, voice: options.voice, ...(language === undefined ? {} : { language }) },
      options,
    );
  }

  /** Connects the call to the Relay at `url`. The Caller may always talk over a reply (`interruptible: "speech"`). */
  startRelay(callControlId: string, options: StartRelayOptions): Promise<void> {
    const body: Record<string, unknown> = { url: options.url, voice: options.voice };
    if (options.language) body.language = options.language;
    if (options.sttEngine) body.transcription_engine = options.sttEngine;
    if (options.sttModel) body.transcription_engine_config = { transcription_model: options.sttModel };
    body.interruptible = "speech";
    return this.#send("conversation_relay_start", callControlId, body, options);
  }

  stopRelay(callControlId: string, options: CommandOptions = {}): Promise<void> {
    return this.#send("conversation_relay_stop", callControlId, {}, options);
  }

  /** Removes the key from text that is going into an error. */
  #redact(value: string): string {
    return value.split(this.#apiKey).join("[redacted]");
  }

  /** A copy of a failure with the same name and nothing else: its message, stack and fields could hold the key. */
  #cleanCause(failure: unknown): Error {
    const original = failure instanceof Error ? failure : new Error(String(failure));
    const clean = new Error(this.#redact(original.message));
    clean.name = original.name;
    clean.stack = this.#redact(original.stack ?? `${original.name}: ${original.message}`);
    return clean;
  }

  async #send(command: TelnyxCommand, callControlId: string, fields: Record<string, unknown>, options: CommandOptions): Promise<void> {
    const url = `${this.#baseUrl}/v2/calls/${pathSegment(callControlId)}/actions/${command}`;
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const timedOut = () =>
      new TelnyxError(`Telnyx gave no response to the ${command} command within ${this.#timeoutMs} ms.`, {
        command,
        cause: this.#cleanCause(signal.reason),
      });

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ...fields, command_id: options.commandId ?? randomUUID() }),
        signal,
      });
    } catch (failure) {
      if (signal.aborted) throw timedOut();
      throw new TelnyxError(`Could not reach Telnyx for the ${command} command: ${this.#redact(failure instanceof Error ? failure.message : String(failure))}`, {
        command,
        cause: this.#cleanCause(failure),
      });
    }

    if (response.ok) {
      // Only "ok" matters. Free the connection without waiting for a body that is not needed.
      void response.body?.cancel().catch(() => undefined);
      return;
    }
    throw await this.#refusal(command, response, signal);
  }

  /** The error for a response that is not a success: its status, and what Telnyx says if its body can be read in time. */
  async #refusal(command: TelnyxCommand, response: Response, signal: AbortSignal): Promise<TelnyxError> {
    const status = response.status;
    let code: string | undefined;
    let title: string | undefined;
    let detail: string | undefined;
    let pointer: string | undefined;

    try {
      const body = await readText(response, signal);
      const parsed: unknown = JSON.parse(body);
      const first = isObject(parsed) && Array.isArray(parsed.errors) ? (parsed.errors as unknown[])[0] : undefined;
      if (isObject(first)) {
        code = typeof first.code === "number" ? String(first.code) : text(first.code);
        title = text(first.title);
        detail = text(first.detail);
        pointer = isObject(first.source) ? text(first.source.pointer) : undefined;
      }
    } catch {
      // A body that is not JSON, or never finished, leaves the status alone. Its text is not repeated: it is not ours.
    }
    code = code === undefined ? undefined : this.#redact(code);
    title = title === undefined ? undefined : this.#redact(title);
    detail = detail === undefined ? undefined : this.#redact(detail);
    pointer = pointer === undefined ? undefined : this.#redact(pointer);

    const parts = [`HTTP ${status}`];
    if (code !== undefined) parts.push(`code ${code}`);
    const what = [title, pointer === undefined ? undefined : `at ${pointer}`].filter((part) => part !== undefined).join(", ");
    const inside = what === "" ? parts.join(", ") : `${parts.join(", ")}: ${what}`;
    const hint = status === 401 ? " Check TELNYX_API_KEY." : "";
    return new TelnyxError(`Telnyx refused the ${command} command (${inside}).${hint}`, { command, status, code, detail });
  }
}

/** The body of a response as text, given up on when `signal` aborts even if the body stream does not notice. */
function readText(response: Response, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason as Error);
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
    response.text().then(resolve, reject);
  });
}
