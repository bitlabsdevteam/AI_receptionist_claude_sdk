import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/config.js";
import { ElevenLabsVoice } from "../src/voice/elevenlabs.js";

/**
 * Opt-in check of the Voice against the real ElevenLabs endpoints: `npm run test:live` (sets RUN_LIVE=1). Skipped
 * otherwise, so `npm test` needs no key and no network. It spends a few ElevenLabs credits (one short sentence spoken
 * and transcribed) and takes a few seconds. It reads ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID from the environment
 * or `.env`, and fails with a clear message if either is missing.
 *
 * Nothing is played and the microphone is never opened: the player keeps the mp3 instead of playing it, and the
 * recorder hands that same mp3 back as the Caller's clip. So the second check depends on the first.
 *
 * It checks facts that should hold on every run, not exact wording: a transcript varies in case and punctuation.
 */
const SENTENCE = "Thank you for calling. Your appointment is on Tuesday morning.";
const EXPECTED_WORDS = ["calling", "appointment", "tuesday"];

describe.skipIf(!process.env.RUN_LIVE)("the Voice against the real ElevenLabs endpoints", () => {
  /** The mp3 that `speak` got back. */
  let spoken: Uint8Array | undefined;

  function liveVoice(): ElevenLabsVoice {
    loadDotEnv();
    return ElevenLabsVoice.fromEnv(process.env, {
      player: async (path) => {
        spoken = new Uint8Array(await readFile(path));
      },
      recorder: async () => {
        if (!spoken) throw new Error("there is no clip to transcribe, because the speak check produced none");
        return spoken;
      },
    });
  }

  it("speaks a sentence and gets mp3 audio back", { timeout: 60_000 }, async () => {
    await liveVoice().speak(SENTENCE);

    // A few seconds of speech at 128 kbps is tens of kilobytes.
    expect(spoken?.byteLength ?? 0).toBeGreaterThan(1_000);
    expect(looksLikeMp3(spoken!)).toBe(true);
  });

  it("hears the words of that sentence in the clip", { timeout: 60_000 }, async () => {
    const heard = (await liveVoice().listen()).toLowerCase();

    for (const word of EXPECTED_WORDS) expect(heard).toContain(word);
  });
});

/** An mp3 starts with an ID3 tag or with an MPEG frame, whose first eleven bits are all set. */
function looksLikeMp3(bytes: Uint8Array): boolean {
  const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  const frame = bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;
  return id3 || frame;
}
