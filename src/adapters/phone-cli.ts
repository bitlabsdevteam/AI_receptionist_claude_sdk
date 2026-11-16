import { loadDotEnv, ConfigError } from "../config.js";
import { readPhoneConfig } from "../phone-config.js";
import { TelnyxClient } from "../telnyx/client.js";
import { startPhoneServer } from "./phone-server.js";
import { loadFlowAndEngine, runProgram } from "./program.js";

/**
 * `npm run phone`: the Receptionist answers calls that Telnyx sends to this server. It does not start ngrok, buy a
 * number or place a call. It prints the webhook address to paste into the Telnyx portal, then waits. Ctrl-C hangs up the
 * Calls in progress and exits 0.
 */
runProgram(async () => {
  loadDotEnv();
  const read = readPhoneConfig(process.env);
  if ("problems" in read) throw new ConfigError(read.problems.join("\n"));
  const { config } = read;
  const { engine } = await loadFlowAndEngine();

  const write = (text: string): void => void process.stdout.write(text);
  const server = await startPhoneServer({ config, engine, client: TelnyxClient.fromEnv(process.env), write });

  write(`Webhook address: ${config.webhookUrl}\n`);
  write(`Listening on port ${server.port}. Press Ctrl-C to hang up any Calls and stop.\n`);

  return new Promise<number>((done) => {
    let stopping = false;
    const stop = (): void => {
      // A second Ctrl-C does not wait for the hang-ups.
      if (stopping) return process.exit(0);
      stopping = true;
      void (async () => {
        const hungUp = await server.hangUpAll();
        if (hungUp > 0) write(`Hung up ${hungUp} Call${hungUp === 1 ? "" : "s"}.\n`);
        await server.close();
        done(0);
      })();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
});
