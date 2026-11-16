import { describe, expect, it } from "vitest";
import { RecentSet } from "../src/recent-set.js";

describe("RecentSet", () => {
  it("remembers what was added", () => {
    const set = new RecentSet<string>(3);
    set.add("a");

    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(false);
  });

  it("forgets the oldest once it holds more than its limit", () => {
    const set = new RecentSet<string>(3);
    for (const id of ["a", "b", "c", "d"]) set.add(id);

    expect(set.has("a")).toBe(false);
    expect(["b", "c", "d"].every((id) => set.has(id))).toBe(true);
    expect(set.size).toBe(3);
  });

  it("does not age what is added again: it counts once", () => {
    const set = new RecentSet<string>(2);
    set.add("a");
    set.add("a");
    set.add("b");

    expect(set.has("a")).toBe(true);
    expect(set.size).toBe(2);
  });
});
