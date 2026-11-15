import { readFile } from "node:fs/promises";
import { FlowValidationError, parseFlow, type Flow, type ParseFlowOptions } from "./schema.js";

export async function loadFlow(path: string, options: Omit<ParseFlowOptions, "source"> = {}): Promise<Flow> {
  const text = await readFile(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new FlowValidationError([`not valid JSON (${(cause as Error).message})`], path);
  }
  return parseFlow(raw, { ...options, source: path });
}
