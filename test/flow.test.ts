import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFlow } from "../src/flow/load.js";
import { FlowValidationError, parseFlow } from "../src/flow/schema.js";

const SHIPPED_FLOW = "flows/receptionist.json";

describe("loading the shipped receptionist Flow", () => {
  it("loads flows/receptionist.json: Ava at Acme Co., starting at the start Node, ending at goodbye", async () => {
    const flow = await loadFlow(SHIPPED_FLOW);

    expect(flow.variables).toMatchObject({
      receptionist_name: "Ava",
      company_name: "Acme Co.",
    });
    expect(flow.start_node).toBe("start");
    expect(flow.nodes.map((n) => n.id)).toEqual(["start"]);
    expect(Object.keys(flow.end_states)).toEqual(["goodbye"]);
    expect(flow.end_states.goodbye?.message).not.toBe("");
    expect(flow.edges).toEqual([
      expect.objectContaining({ id: "e_start_goodbye", from: "start", to: "goodbye" }),
    ]);
  });
});

describe("rejecting an invalid Flow at startup", () => {
  // A plain-JSON copy of the shipped Flow, mutated per test into one broken Flow.
  let shipped: Record<string, any>;
  beforeAll(async () => {
    shipped = JSON.parse(await readFile(SHIPPED_FLOW, "utf8"));
  });
  const broken = (mutate: (flow: Record<string, any>) => void): unknown => {
    const copy = structuredClone(shipped);
    mutate(copy);
    return copy;
  };

  it("accepts the shipped Flow unchanged", () => {
    expect(() => parseFlow(structuredClone(shipped))).not.toThrow();
  });

  it("rejects an Edge that points at a Node or End state that does not exist", () => {
    const flow = broken((f) => {
      f.edges[0].to = "nowhere";
    });
    expect(() => parseFlow(flow)).toThrow(FlowValidationError);
    expect(() => parseFlow(flow)).toThrow(/e_start_goodbye.*nowhere/s);
  });

  it("rejects an Edge that leaves from a Node that does not exist", () => {
    const flow = broken((f) => {
      f.edges[0].from = "ghost";
    });
    expect(() => parseFlow(flow)).toThrow(/e_start_goodbye.*ghost/s);
  });

  it("rejects a Flow whose start_node is not a Node", () => {
    const flow = broken((f) => {
      f.start_node = "begin";
    });
    expect(() => parseFlow(flow)).toThrow(/start_node.*begin/s);
  });

  it("rejects a Node that no path from the start Node can reach", () => {
    const flow = broken((f) => {
      f.nodes.push({ ...f.nodes[0], id: "orphan" });
    });
    expect(() => parseFlow(flow)).toThrow(/orphan.*unreachable/s);
  });

  it("rejects duplicate Node ids and duplicate Edge ids", () => {
    const dupNode = broken((f) => {
      f.nodes.push({ ...f.nodes[0] });
    });
    expect(() => parseFlow(dupNode)).toThrow(/duplicate Node id "start"/);

    const dupEdge = broken((f) => {
      f.edges.push({ ...f.edges[0] });
    });
    expect(() => parseFlow(dupEdge)).toThrow(/duplicate Edge id "e_start_goodbye"/);
  });

  it("rejects a Node and an End state that share a name, since Edges could not tell them apart", () => {
    const flow = broken((f) => {
      f.end_states.start = { message: "Bye." };
    });
    expect(() => parseFlow(flow)).toThrow(/"start".*both a Node and an End state/s);
  });

  it("rejects a Node that lists a tool the registry does not have", () => {
    const flow = broken((f) => {
      f.nodes[0].tools = ["verify_identity"];
    });
    expect(() => parseFlow(flow)).toThrow(/Node "start".*unknown tool "verify_identity"/s);
    expect(() => parseFlow(flow, { knownTools: ["verify_identity"] })).not.toThrow();
  });

  it("rejects a Flow with no default_model, since Nodes without their own model would have none", () => {
    const flow = broken((f) => {
      delete f.default_model;
    });
    expect(() => parseFlow(flow)).toThrow(/default_model/);
  });

  it("rejects a model that is neither anthropic/<id> nor openrouter/<vendor>/<model>", () => {
    for (const model of ["claude-sonnet-5-5", "openai/gpt-5", "openrouter/just-one-part", "anthropic/"]) {
      const onNode = broken((f) => {
        f.nodes[0].model = model;
      });
      expect(() => parseFlow(onNode), `Node model ${model}`).toThrow(/model/);
      const asDefault = broken((f) => {
        f.default_model = model;
      });
      expect(() => parseFlow(asDefault), `default_model ${model}`).toThrow(/default_model/);
    }
  });

  it("accepts an openrouter/<vendor>/<model> model on a Node", () => {
    const flow = broken((f) => {
      f.nodes[0].model = "openrouter/google/gemini-3-flash";
    });
    expect(() => parseFlow(flow)).not.toThrow();
  });

  it("rejects unknown fields, so a typo such as 'instruction' is not silently ignored", () => {
    const flow = broken((f) => {
      f.nodes[0].instruction = "oops";
    });
    expect(() => parseFlow(flow)).toThrow(/instruction/);
  });

  it("reports every problem at once, not just the first", () => {
    const flow = broken((f) => {
      f.edges[0].to = "nowhere";
      f.start_node = "begin";
    });
    try {
      parseFlow(flow);
      expect.unreachable("parseFlow should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FlowValidationError);
      expect((error as FlowValidationError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("loading a Flow file that cannot be used", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "flow-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names the file when it does not exist", async () => {
    await expect(loadFlow(join(dir, "missing.json"))).rejects.toThrow(/missing\.json/);
  });

  it("rejects a file that is not JSON, naming the file", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, "{ not json");
    await expect(loadFlow(path)).rejects.toThrow(FlowValidationError);
    await expect(loadFlow(path)).rejects.toThrow(/broken\.json.*not valid JSON/s);
  });

  it("rejects a file that is JSON but not a Flow, naming the file", async () => {
    const path = join(dir, "empty.json");
    await writeFile(path, "{}");
    await expect(loadFlow(path)).rejects.toThrow(/empty\.json/);
  });

  it("passes knownTools through, so a Flow that uses a registered tool loads", async () => {
    const flow = JSON.parse(await readFile(SHIPPED_FLOW, "utf8"));
    flow.nodes[0].tools = ["verify_identity"];
    const path = join(dir, "with-tool.json");
    await writeFile(path, JSON.stringify(flow));
    await expect(loadFlow(path)).rejects.toThrow(/unknown tool/);
    await expect(loadFlow(path, { knownTools: ["verify_identity"] })).resolves.toBeDefined();
  });
});
