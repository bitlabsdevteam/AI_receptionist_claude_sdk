import { describe, expect, it } from "vitest";
import { InMemorySessionStore, type Session } from "../src/engine/session.js";

const session = (): Session => ({
  callId: "call-1",
  currentNodeId: "start",
  transcript: [],
  variables: { assistant_name: "Ava" },
  turns: {},
  createdAt: 1,
  updatedAt: 1,
});

describe("InMemorySessionStore", () => {
  it("returns undefined for an unknown Call, and what was put for a known one", async () => {
    const store = new InMemorySessionStore();
    expect(await store.get("call-1")).toBeUndefined();

    await store.put(session());
    expect(await store.get("call-1")).toEqual(session());
  });

  it("deletes a Call", async () => {
    const store = new InMemorySessionStore();
    await store.put(session());

    await store.delete("call-1");

    expect(await store.get("call-1")).toBeUndefined();
  });

  it("hands out copies, like a store that serialises, so callers must put changes back", async () => {
    const store = new InMemorySessionStore();
    await store.put(session());

    const copy = await store.get("call-1");
    copy!.variables.assistant_name = "Bea";

    expect((await store.get("call-1"))?.variables.assistant_name).toBe("Ava");
  });
});
