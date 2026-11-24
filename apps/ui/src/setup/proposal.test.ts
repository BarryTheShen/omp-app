import { describe, expect, test } from "vitest";
import type { SettingDef } from "../settings/data";
import { interviewPrompt, PROPOSAL_LANGUAGE, readProposal } from "./proposal";

const def = (over: Partial<SettingDef> & Pick<SettingDef, "key" | "type">): SettingDef => ({
  tab: "interaction",
  group: null,
  label: over.key,
  description: "",
  ...over,
});
const DEFS: readonly SettingDef[] = [
  def({ key: "tools.approvalMode", type: "enum", values: ["always-ask", "write", "yolo"] }),
  def({ key: "retry.waitForUsageReset", type: "boolean" }),
  def({
    key: "todo.remindersMax",
    type: "number",
    choices: [
      { value: "1", label: "1" },
      { value: "3", label: "3" },
    ],
  }),
  def({ key: "hindsight.apiToken", type: "string", secret: true }),
  def({ key: "compaction.idleEnabled", type: "boolean", terminalOnly: true }),
  def({ key: "task.agentModelOverrides", type: "record" }),
];

describe("a chat's proposed settings", () => {
  test("keeps only settings the setup changes with values they take, once each, and says why the rest are left", () => {
    const { proposed, left } = readProposal(
      JSON.stringify([
        { key: "tools.approvalMode", value: "write", why: "You review file changes" },
        { key: "tools.approvalMode", value: "yolo" },
        { key: "retry.waitForUsageReset", value: "yes" },
        { key: "todo.remindersMax", value: 3 },
        { key: "todo.remindersMax", value: 7 },
        { key: "hindsight.apiToken", value: "x" },
        { key: "compaction.idleEnabled", value: true },
        { key: "task.agentModelOverrides", value: "{}" },
        { key: "no.such", value: 1 },
      ]),
      DEFS,
    );
    expect(proposed).toEqual([
      { key: "tools.approvalMode", value: "write", why: "You review file changes" },
      { key: "todo.remindersMax", value: 3, why: "" },
    ]);
    expect(left).toHaveLength(6);
  });

  test("an unreadable block proposes nothing", () => {
    expect(readProposal("not json", DEFS).proposed).toEqual([]);
    expect(readProposal('{"key":"x"}', DEFS).proposed).toEqual([]);
  });

  test("the interview names the block's language and lists only proposable settings", () => {
    const prompt = interviewPrompt(DEFS);
    expect(prompt).toContain(PROPOSAL_LANGUAGE);
    expect(prompt).toContain("tools.approvalMode (always-ask | write | yolo)");
    expect(prompt).not.toContain("hindsight.apiToken");
    expect(prompt).not.toContain("compaction.idleEnabled");
    expect(prompt).not.toContain("task.agentModelOverrides");
  });
});
