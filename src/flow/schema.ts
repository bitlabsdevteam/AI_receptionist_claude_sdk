import { z } from "zod";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** `anthropic/<id>` (default provider) or `openrouter/<vendor>/<model>`. */
const modelSchema = z
  .string()
  .regex(
    /^(anthropic\/[^/\s]+|openrouter\/[^/\s]+\/\S+)$/,
    "must look like anthropic/<id> or openrouter/<vendor>/<model>",
  );

const nodeSchema = z.strictObject({
  id: z.string().min(1),
  type: z.literal("prompt"),
  instructions: z.string().min(1),
  model: modelSchema.optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  tools: z.array(z.string().min(1)).default([]),
  max_tool_rounds: z.number().int().positive().default(3),
});

const edgeSchema = z.strictObject({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  condition: z.strictObject({
    type: z.literal("llm"),
    prompt: z.string().min(1),
  }),
});

const endStateSchema = z.strictObject({
  message: z.string().min(1),
});

export const flowSchema = z.strictObject({
  base_instructions: z.string().default(""),
  default_model: modelSchema,
  variables: z.record(z.string(), z.string()).default({}),
  start_node: z.string().min(1),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema).default([]),
  end_states: z.record(z.string().min(1), endStateSchema),
});

export type Flow = z.infer<typeof flowSchema>;
export type FlowNode = Flow["nodes"][number];
export type FlowEdge = Flow["edges"][number];

/** Thrown when a Flow fails validation. `issues` lists every problem found, one per entry. */
export class FlowValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[], source?: string) {
    const where = source ? ` in ${source}` : "";
    super(`Invalid Flow${where}:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "FlowValidationError";
    this.issues = issues;
  }
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const id of ids) (seen.has(id) ? dups : seen).add(id);
  return [...dups];
}

/** Checks that cross-reference between parts of the Flow, which the shape schema cannot express. */
function checkReferences(flow: Flow, knownTools: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  const nodeIds = new Set(flow.nodes.map((n) => n.id));
  const endStates = new Set(Object.keys(flow.end_states));

  for (const id of duplicates(flow.nodes.map((n) => n.id))) {
    issues.push(`duplicate Node id "${id}"`);
  }
  for (const id of duplicates(flow.edges.map((e) => e.id))) {
    issues.push(`duplicate Edge id "${id}"`);
  }
  for (const id of nodeIds) {
    if (endStates.has(id)) issues.push(`"${id}" is both a Node and an End state`);
  }

  for (const node of flow.nodes) {
    for (const tool of node.tools) {
      if (!knownTools.has(tool)) issues.push(`Node "${node.id}" lists unknown tool "${tool}"`);
    }
  }

  if (!nodeIds.has(flow.start_node)) {
    issues.push(`start_node "${flow.start_node}" is not a Node`);
  }
  for (const edge of flow.edges) {
    if (!nodeIds.has(edge.from)) {
      issues.push(`Edge "${edge.id}" starts at "${edge.from}", which is not a Node`);
    }
    if (!nodeIds.has(edge.to) && !endStates.has(edge.to)) {
      issues.push(`Edge "${edge.id}" goes to "${edge.to}", which is neither a Node nor an End state`);
    }
  }

  if (nodeIds.has(flow.start_node)) {
    const reachable = new Set([flow.start_node]);
    const queue = [flow.start_node];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      for (const edge of flow.edges) {
        if (edge.from === id && nodeIds.has(edge.to) && !reachable.has(edge.to)) {
          reachable.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    for (const id of nodeIds) {
      if (!reachable.has(id)) issues.push(`Node "${id}" is unreachable from start_node "${flow.start_node}"`);
    }
  }
  return issues;
}

export interface ParseFlowOptions {
  /** Names in the tool registry. A Node may only list tools named here. Defaults to none. */
  knownTools?: Iterable<string>;
  /** Where the Flow came from (a file path), for error messages. */
  source?: string;
}

/** Validates untrusted data (parsed JSON) as a Flow, or throws `FlowValidationError`. */
export function parseFlow(raw: unknown, options: ParseFlowOptions = {}): Flow {
  const { source, knownTools = [] } = options;
  const result = flowSchema.safeParse(raw);
  if (!result.success) {
    throw new FlowValidationError(
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      source,
    );
  }
  const issues = checkReferences(result.data, new Set(knownTools));
  if (issues.length > 0) throw new FlowValidationError(issues, source);
  return result.data;
}
