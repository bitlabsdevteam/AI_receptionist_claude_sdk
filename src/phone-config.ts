import { anthropicKeyProblem } from "./config.js";
import { telnyxBaseUrlProblem } from "./telnyx/client.js";
import { isTelnyxPublicKey } from "./telnyx/signature.js";

/** What `npm run phone` reads from the environment, with the defaults the spec plans until the spike chooses. */
export interface PhoneConfig {
  /** `TELNYX_PUBLIC_KEY`: checks the signature on every webhook. */
  publicKey: string;
  /** The `wss://` address Telnyx connects the Relay to, with nothing after the host: `<relayBase>/telnyx/relay/<token>`. */
  relayBase: string;
  /** The address to paste into the Telnyx portal as the application's webhook URL. */
  webhookUrl: string;
  /** The numbers that may call, in E.164 form. Undefined when there is no list, which lets any Caller call. */
  allowedCallers: ReadonlySet<string> | undefined;
  voice: string;
  sttEngine: string;
  sttModel: string;
  language: string;
  port: number;
}

export const WEBHOOK_PATH = "/telnyx/webhooks";
export const RELAY_PATH = "/telnyx/relay/";

const E164 = /^\+[1-9]\d{6,14}$/;

function set(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === "" ? undefined : value;
}

function notSet(name: string, hint: string): string {
  return `${name} is not set. ${hint}, or export ${name} in your shell.`;
}

/**
 * Reads and checks what the phone program needs. It gives every problem at once, one line each, so they can all be
 * fixed in one go, and no line repeats a value, since a value may be a key. A variable that is optional and blank
 * takes its default.
 */
export function readPhoneConfig(env: NodeJS.ProcessEnv): { config: PhoneConfig } | { problems: string[] } {
  const problems: string[] = [];

  const anthropic = anthropicKeyProblem(env);
  if (anthropic) problems.push(anthropic);

  const apiKey = set(env, "TELNYX_API_KEY");
  if (apiKey === undefined) {
    problems.push(notSet("TELNYX_API_KEY", "Put your Telnyx API key in .env (bash scripts/telnyx-setup.sh records it)"));
  } else {
    // The Telnyx address is checked with the client's own rule, which says what is wrong with it. It never holds the key.
    const addressProblem = telnyxBaseUrlProblem(env);
    if (addressProblem) problems.push(addressProblem);
  }

  const publicKey = set(env, "TELNYX_PUBLIC_KEY");
  if (publicKey === undefined) {
    problems.push(notSet("TELNYX_PUBLIC_KEY", "Put your Telnyx account's public key from the portal in .env"));
  } else if (!isTelnyxPublicKey(publicKey)) {
    problems.push("TELNYX_PUBLIC_KEY is not the Base64 of 32 bytes. Copy it again from the Telnyx portal.");
  }

  let host: string | undefined;
  const baseUrl = set(env, "PUBLIC_BASE_URL");
  if (baseUrl === undefined) {
    problems.push(notSet("PUBLIC_BASE_URL", "Put the public https:// address of this server (the ngrok address) in .env"));
  } else {
    host = publicHost(baseUrl);
    if (host === undefined) {
      problems.push("PUBLIC_BASE_URL must be an https:// address with nothing after the host, such as https://example.ngrok.app.");
    }
  }

  let allowedCallers: Set<string> | undefined;
  const list = set(env, "PHONE_ALLOWED_CALLERS");
  if (list !== undefined) {
    const entries = list
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (entries.every((entry) => E164.test(entry))) allowedCallers = entries.length > 0 ? new Set(entries) : undefined;
    else problems.push("PHONE_ALLOWED_CALLERS must list phone numbers in E.164 form, such as +14155550100, separated by commas.");
  }

  let port = 3000;
  const rawPort = set(env, "PORT");
  if (rawPort !== undefined) {
    if (/^\d+$/.test(rawPort) && Number(rawPort) <= 65535) port = Number(rawPort);
    else problems.push("PORT must be a whole number from 0 to 65535.");
  }

  if (problems.length > 0 || publicKey === undefined || host === undefined) return { problems };
  return {
    config: {
      publicKey,
      relayBase: `wss://${host}`,
      webhookUrl: `https://${host}${WEBHOOK_PATH}`,
      allowedCallers,
      voice: set(env, "TELNYX_TTS_VOICE") ?? "Telnyx.Ultra.Callie",
      sttEngine: set(env, "TELNYX_STT_ENGINE") ?? "Deepgram",
      sttModel: set(env, "TELNYX_STT_MODEL") ?? "deepgram/nova-3",
      language: set(env, "VOICE_LANGUAGE") ?? "en",
      port,
    },
  };
}

/** The host (and port) of an `https://` address that has nothing after it but a slash, or undefined. */
function publicHost(address: string): string | undefined {
  if (!/^https:\/\/[^/?#@\s]+\/?$/.test(address)) return undefined;
  try {
    return new URL(address).host || undefined;
  } catch {
    return undefined;
  }
}
