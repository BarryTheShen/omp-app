import type { SlashCommand } from "../contract";
import capture from "./real-get-available-commands-with-skill-and-mcp.json";

/** omp 18.8.9's get_available_commands over --mode rpc-ui, recorded with one skill, one stdio MCP server offering one prompt, and two prompt templates (not listed). */
export const RECORDED_COMMANDS: readonly unknown[] = capture.commands;

/** The recorded entries of one command source, in the order omp listed them. */
export function recordedCommandsFrom(source: SlashCommand["source"]): readonly unknown[] {
  return RECORDED_COMMANDS.filter(
    (entry) =>
      typeof entry === "object" && entry !== null && "source" in entry && entry.source === source,
  );
}
