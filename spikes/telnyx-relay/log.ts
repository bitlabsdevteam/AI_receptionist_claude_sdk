import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The spike's log: one JSON object per line, each with a millisecond timestamp. Everything written goes through the
 * masker first, so the file never holds a key or a full phone number (last four digits only), and neither does the
 * terminal, which prints from the masked record.
 */

/** Fields whose value is a phone number even when it has no plus sign. Compared in lower case. */
const NUMBER_FIELDS = new Set(["from", "to", "caller_id_number", "phone_number", "caller", "called"]);

/** Fields that hold the Caller's name. Compared in lower case. */
const NAME_FIELDS = new Set(["caller_id_name", "callername"]);

/** A plus sign and 7 to 15 digits that are not part of a longer run of Base64, so a signature is left alone. */
const E164 = /(?<![A-Za-z0-9/=+])\+\d{7,15}(?![A-Za-z0-9/+=])/g;

function lastFour(text: string): string {
  const digits = text.replace(/\D/g, "");
  return `${text.startsWith("+") ? "+" : ""}***${digits.slice(-4)}`;
}

export interface Masker {
  /** A copy of `value` with every key redacted and every phone number cut to its last four digits. */
  mask<T>(value: T): T;
  /** Tells the masker a number to hide in any spelling: with or without the country code, spaced or punctuated. */
  addNumber(number: string): void;
  /** Tells the masker a secret to redact wherever it appears. */
  addSecret(secret: string): void;
}

export function createMasker(): Masker {
  const secrets: string[] = [];
  const numbers: RegExp[] = [];

  function maskText(text: string, field: string | undefined): string {
    let out = text;
    for (const secret of secrets) out = out.replaceAll(secret, "[redacted]");
    for (const number of numbers) out = out.replace(number, lastFour);
    out = out.replace(E164, lastFour);
    if (field !== undefined && NUMBER_FIELDS.has(field.toLowerCase())) out = out.replace(/\+?\d{5,}/g, lastFour);
    return out;
  }

  function maskValue(value: unknown, field: string | undefined): unknown {
    if (typeof value === "string") {
      if (field !== undefined && NAME_FIELDS.has(field.toLowerCase())) return value === "" ? "" : "[masked]";
      return maskText(value, field);
    }
    if (Array.isArray(value)) return value.map((item) => maskValue(item, field));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskValue(item, key)]));
    }
    return value;
  }

  return {
    mask: <T>(value: T) => maskValue(value, undefined) as T,
    addSecret(secret) {
      if (secret !== "") secrets.push(secret);
    },
    addNumber(number) {
      const digits = number.replace(/\D/g, "");
      if (digits.length < 7) return;
      // The whole number first, then its last ten digits (the national form of a US number).
      for (const form of digits.length > 10 ? [digits, digits.slice(-10)] : [digits]) {
        numbers.push(new RegExp(`(?<!\\d)\\+?\\(?${form.split("").join("[\\s().-]*")}(?!\\d)`, "g"));
      }
    },
  };
}

export interface SpikeLog extends Masker {
  readonly path: string;
  /** Appends one line and returns the record as written (masked). */
  write(kind: string, fields?: Record<string, unknown>): Record<string, unknown>;
}

export function openLog(path: string, now: () => number = Date.now): SpikeLog {
  mkdirSync(dirname(path), { recursive: true });
  const masker = createMasker();
  return {
    ...masker,
    path,
    write(kind, fields = {}) {
      const t = now();
      const record = masker.mask({ ts: new Date(t).toISOString(), t_ms: t, kind, ...fields });
      appendFileSync(path, `${JSON.stringify(record)}\n`);
      return record;
    },
  };
}
