import { ToolCard } from "./card";
import type { ToolRenderer } from "./contract";
import { normalizeToolRendererProps } from "./normalize";

const LONG_STRING_LIMIT = 240;

/** Generic render-only fallback for unknown, custom, host and MCP tool calls. */
export const ToolFallback: ToolRenderer = (props) => {
  const normalized = normalizeToolRendererProps(props);
  const state = {
    ...normalized,
    argsText: prettyArguments(props.args, normalized.argsText),
  };
  return <ToolCard state={state} />;
};

function prettyArguments(value: unknown, rawText: string): string {
  if (value === undefined) return rawText;
  try {
    const formatted = JSON.stringify(
      value,
      (_key, nested) => {
        if (typeof nested !== "string" || nested.length <= LONG_STRING_LIMIT) return nested;
        const head = nested.slice(0, LONG_STRING_LIMIT);
        return `${head}… [${nested.length} chars]`;
      },
      2,
    );
    return formatted ?? rawText;
  } catch {
    return rawText;
  }
}
