import { describe, expect, it } from "vitest";
import { LineQueue } from "../src/adapters/line-queue.js";

describe("LineQueue", () => {
  it("hands out lines in order, including lines that arrived before anyone asked", async () => {
    const lines = new LineQueue();
    lines.push("first");
    lines.push("second");

    expect(await lines.next()).toBe("first");
    expect(await lines.next()).toBe("second");
  });

  it("waits for a line that has not arrived yet", async () => {
    const lines = new LineQueue();
    const waiting = lines.next();
    lines.push("hello");

    expect(await waiting).toBe("hello");
  });

  it("hands out what it holds and then nothing, once the input has closed", async () => {
    const lines = new LineQueue();
    lines.push("last words");
    lines.close();

    expect(await lines.next()).toBe("last words");
    expect(await lines.next()).toBeUndefined();
  });

  it("ends a wait when the input closes", async () => {
    const lines = new LineQueue();
    const waiting = lines.next();
    lines.close();

    expect(await waiting).toBeUndefined();
  });
});

describe("a wait that is called off", () => {
  it("ends without a line, and does not swallow the Caller's next line", async () => {
    const lines = new LineQueue();
    const calledOff = new AbortController();
    const waiting = lines.next(calledOff.signal);

    calledOff.abort();
    lines.push("this is for the next prompt");

    expect(await waiting).toBeUndefined();
    expect(await lines.next()).toBe("this is for the next prompt");
  });

  it("takes no line when it was called off before it began", async () => {
    const lines = new LineQueue();
    lines.push("still here");

    expect(await lines.next(AbortSignal.abort())).toBeUndefined();
    expect(await lines.next()).toBe("still here");
  });

  it("changes nothing once the line has been handed out", async () => {
    const lines = new LineQueue();
    const calledOff = new AbortController();
    const waiting = lines.next(calledOff.signal);
    lines.push("stop");
    calledOff.abort();
    lines.push("next");

    expect(await waiting).toBe("stop");
    expect(await lines.next()).toBe("next");
  });
});
