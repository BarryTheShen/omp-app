import {
  AppFailure,
  type ToolAvailability,
  type ToolsAvailabilityResult,
} from "@omp-app/contracts";
import type { CommandParserContext, OmpCommandGatewayService } from "./gateway";

/**
 * omp's `builtin-session.ts:520-539` format (v18.12.6): `*` and `-` name ordinary tools; `~ xd://name`
 * repeats the same tool when it is mounted on the xd:// device. The browser receives one typed row per tool.
 */
const TOOL_LINE = /^([*~-])\s+(.+)$/u;

function unrecognized(): AppFailure {
  return new AppFailure({
    code: "internal",
    message: "The app could not read omp's reply to /tools.",
    retryable: false,
  });
}

function parseToolLine(line: string): { readonly marker: string; readonly tool: string } {
  const match = TOOL_LINE.exec(line);
  if (match === null) throw unrecognized();
  const marker = match[1];
  const rawTool = match[2]?.trim();
  if (marker === undefined || rawTool === undefined || rawTool.length === 0) throw unrecognized();
  return {
    marker,
    tool: rawTool.startsWith("xd://") ? rawTool.slice("xd://".length) : rawTool,
  };
}

function stateForMarker(marker: string): ToolAvailability["state"] {
  return marker === "*" ? "available" : marker === "-" ? "unavailable" : "fallback";
}

export function parseToolsReply(context: CommandParserContext): ToolsAvailabilityResult {
  if (context.command !== "/tools" || context.agentInvoked) throw unrecognized();
  const text = context.outputs
    .map((output) => output.text)
    .join("\n")
    .trim();
  if (text === "No tools are available.") return { tools: [] };
  // omp always prints one of its two shapes, so no text at all is a lost or aborted reply and
  // not an empty inventory.
  if (text.length === 0) throw unrecognized();

  const rows = new Map<string, ToolAvailability>();
  for (const line of text
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const parsed = parseToolLine(line);
    // omp prints the `~ xd://` lines last: a tool that is active and also mounted stays available.
    if (rows.get(parsed.tool)?.state === "available") continue;
    rows.set(parsed.tool, { tool: parsed.tool, state: stateForMarker(parsed.marker) });
  }
  return { tools: [...rows.values()] };
}

export function registerToolsParser(gateway: OmpCommandGatewayService): void {
  gateway.registerCommandParser("tools", parseToolsReply);
}
