import { describe, expect, test } from "vitest";
import { SlashCommand } from "../contract";
import { rankSlashEntries, sourceLabel } from "./rank";
import { REAL_COMMAND_LIST } from "./test-support";

const realEntries = REAL_COMMAND_LIST.map((raw) => SlashCommand.parse(raw));

describe("D2.3 slash ranking on omp's real list", () => {
  test("an alias finds its command, with the command's own description", () => {
    const [first] = rankSlashEntries(realEntries, "models");
    expect(first).toMatchObject({
      id: "slash:builtin:model",
      label: "/model",
      description: "Show current model selection",
      insertText: "/model ",
    });
  });

  test("once a space follows the command, its subcommands are listed with their usage", () => {
    const candidates = rankSlashEntries(realEntries, "/usage re");
    expect(candidates[0]).toMatchObject({
      id: "slash:builtin:usage:reset",
      label: "/usage reset",
      insertText: "/usage reset ",
      description:
        "Spend a saved provider rate-limit reset · Usage: [provider/credential-id|provider/active]",
    });
  });

  test("a space with nothing after it lists every subcommand of that command, and no other command", () => {
    const labels = rankSlashEntries(realEntries, "/usage ").map((candidate) => candidate.label);
    expect(labels).toEqual(["/usage reset", "/usage show"]);
  });

  test("arguments typed after a command that has no subcommands list nothing", () => {
    expect(rankSlashEntries(realEntries, "/autoresearch fix the flaky test")).toEqual([]);
  });

  test("a lone slash or a slash and a space lists no subcommands", () => {
    expect(rankSlashEntries(realEntries, "/ ")).toEqual([]);
  });

  test("an argument hint travels as metadata, and the source is a plain label", () => {
    const [security] = rankSlashEntries(realEntries, "/security");
    expect(security?.metadata).toMatchObject({
      sourceLabel: "Built-in",
      argumentHint:
        "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
    });
  });

  test("custom, extension and file commands each carry their own plain source label", () => {
    const labelOf = (name: string) =>
      rankSlashEntries(realEntries, name).find((candidate) => candidate.label === `/${name}`)
        ?.metadata?.sourceLabel;
    expect(labelOf("green")).toBe("Custom");
    expect(labelOf("autoresearch")).toBe("Extension");
    expect(labelOf("init")).toBe("Prompt file");
  });

  test("every source has a plain English label, and nothing is shown as a raw source id", () => {
    expect(sourceLabel("mcp_prompt")).toBe("MCP prompt");
    expect(sourceLabel("client")).toBe("App");
    expect(sourceLabel("a1.github-refs")).toBe("GitHub");
  });

  test("a query that matches nothing ranks nothing", () => {
    expect(rankSlashEntries(realEntries, "zzqx")).toEqual([]);
  });
});
