import { describe, expect, it } from "vitest";
import { loadDotEnv, requireApiKey } from "../src/config.js";
import { AnthropicModelClient } from "../src/engine/anthropic-client.js";
import { FlowEngine } from "../src/engine/engine.js";
import type { ReplyStream } from "../src/engine/reply-stream.js";
import { loadFlow } from "../src/flow/load.js";

/**
 * Opt-in smoke test against the real model: `npm run test:live` (sets RUN_LIVE=1). Skipped otherwise, so `npm test`
 * needs no key and no network. It spends a few cents and takes several seconds. It reads ANTHROPIC_API_KEY from the
 * environment or `.env`, and fails with a clear message if there is none.
 *
 * It checks facts that should hold on every run, not exact wording: the model's replies vary.
 */
describe.skipIf(!process.env.RUN_LIVE)("a short scripted Call against the real model", () => {
  it(
    "greets, answers a question, and ends the Call with the fixed closing message when the Caller says goodbye",
    { timeout: 120_000 },
    async () => {
      loadDotEnv();
      requireApiKey(process.env);
      const flow = await loadFlow("flows/receptionist.json");
      const engine = new FlowEngine(flow, { client: new AnthropicModelClient() });
      const closing = flow.end_states["goodbye"]!.message;

      /** What the Caller would see for one Turn: it must end up equal to the reply, whatever was retracted on the way. */
      function screen() {
        let shown = "";
        let pieces = 0;
        const stream: ReplyStream = {
          text(delta) {
            shown += delta;
            pieces++;
          },
          discard() {
            shown = "";
          },
        };
        return { stream, shown: () => shown, pieces: () => pieces };
      }

      const greetingScreen = screen();
      const greeting = await engine.start("live-call", {}, greetingScreen.stream);
      expect(greeting.reply).toMatch(/Ava/);
      expect(greeting.reply).toMatch(/Acme/);
      expect(greetingScreen.shown()).toBe(greeting.reply);
      expect(greetingScreen.pieces()).toBeGreaterThan(1);

      const answerScreen = screen();
      const answer = await engine.handleUser(
        "live-call",
        "Hi, what is your name, and which company is this?",
        "turn-1",
        answerScreen.stream,
      );
      expect(answer.ended).toBe(false);
      expect(answer.reply).toMatch(/Ava/);
      expect(answer.reply).not.toMatch(/[*#`]/);
      expect(answerScreen.shown()).toBe(answer.reply);

      const byeScreen = screen();
      const bye = await engine.handleUser("live-call", "No, that's all. Goodbye!", "turn-2", byeScreen.stream);
      expect(bye.ended).toBe(true);
      expect(bye.endState).toBe("goodbye");
      expect(bye.reply.endsWith(closing)).toBe(true);
      expect(byeScreen.shown()).toBe(bye.reply);
      // The start Node is told not to say a farewell of its own, so the closing message should appear once.
      expect(bye.reply.split(closing)).toHaveLength(2);
    },
  );
});
