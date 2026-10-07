import type { ToolRendererProps } from "../U3/tool-card/contract";
import type { RealToolResult } from "../U3/tool-card/real-result";
import { T5_REAL_RESULTS } from "./fixtures/real-results";

/** Test helper: one recorded T5 result, by its name in the fixtures file. */
export function sampleNamed(name: string): RealToolResult {
  const sample = T5_REAL_RESULTS.find((item) => item.name === name);
  if (sample === undefined) throw new Error(`No recorded T5 result named "${name}".`);
  return sample;
}

/** The props a card gets for one recorded result, as a transcript passes them. */
export function recorded(name: string): ToolRendererProps {
  const sample = sampleNamed(name);
  return {
    toolCallId: `${sample.toolName}-call`,
    toolName: sample.toolName,
    args: sample.args,
    argsText: JSON.stringify(sample.args),
    result: structuredClone(sample.result),
    isError: sample.isError,
    status: { type: "complete", reason: "stop" },
  } as unknown as ToolRendererProps;
}

/** Replaces one field of a copied value: a malformed shape that must fail visibly. */
function setAt(root: unknown, path: readonly (string | number)[], value: unknown): void {
  let node: unknown = root;
  for (const key of path.slice(0, -1)) {
    node =
      typeof node === "object" && node !== null && key in node ? Reflect.get(node, key) : undefined;
  }
  const last = path.at(-1);
  if (typeof node !== "object" || node === null || last === undefined) {
    throw new Error(`No field at ${path.join(".")}`);
  }
  Reflect.set(node, last, value);
}

/** A recorded result with one field replaced, as card props. */
export function alteredResult(
  name: string,
  path: readonly (string | number)[],
  value: unknown,
): ToolRendererProps {
  const props = recorded(name);
  setAt(props.result, path, value);
  return props;
}

/** A recorded result's details with one field replaced, for the decoders. */
export function alteredDetails(
  name: string,
  path: readonly (string | number)[],
  value: unknown,
): unknown {
  const details = structuredClone(sampleNamed(name).result.details);
  setAt(details, path, value);
  return details;
}
