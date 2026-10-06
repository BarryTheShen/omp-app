import { describe, expect, test } from "vitest";
import type { ConfigSnapshot, SettingControl, SettingValue } from "../../../S1/settings-kit";
import { S3_SETTINGS_SECTIONS } from "../../sections";

const snapshot: ConfigSnapshot = { folder: null, revision: "revision-1", entries: [] };

const EXPECTED_KEYS = [
  [
    "todo.enabled",
    "glob.enabled",
    "grep.enabled",
    "astGrep.enabled",
    "astEdit.enabled",
    "find.enabled",
    "debug.enabled",
    "launch.enabled",
    "speechgen.enabled",
    "generate_image.enabled",
    "computer.enabled",
    "ratchet.enabled",
    "archive.enabled",
    "checkpoint.enabled",
    "fetch.enabled",
    "vault.enabled",
    "github.enabled",
    "web_search.enabled",
    "security.enabled",
    "ask.enabled",
    "browser.enabled",
    "ida.enabled",
  ],
  [
    "grep.contextBefore",
    "grep.contextAfter",
    "browser.cdpUrl",
    "browser.relay",
    "browser.relayUrl",
    "browser.headless",
    "browser.cmux",
    "browser.tern",
    "browser.freezeOnTurnEnd",
    "browser.idleCloseSec",
    "browser.screenshotDir",
  ],
  ["computer.display", "computer.maxWidth", "computer.maxHeight"],
  ["github.cache.enabled", "github.cache.softTtlSec", "github.cache.hardTtlSec"],
  [
    "tools.artifactSpillThreshold",
    "tools.artifactTailBytes",
    "tools.artifactHeadBytes",
    "tools.outputMaxColumns",
    "tools.artifactTailLines",
    "tools.artifactMaxBytes",
  ],
  [
    "images.questionTimeoutMs",
    "tools.intentTracing",
    "tools.abortOnFabricatedResult",
    "tools.speculativeExecution.enabled",
    "tools.speculativeExecution.maxInFlight",
    "tools.maxTimeout",
    "async.enabled",
    "async.maxJobs",
  ],
  ["extensionHandlers.toolCallTimeoutMs"],
  ["dev.autoqa", "dev.autoqaPush.endpoint"],
  ["ida.python", "ida.installDir", "ida.maxOpen", "ida.idleCloseSec"],
  ["todo.reminders", "todo.remindersMax", "todo.eager", "tasks.todoClearDelay"],
  [
    "skills.enableSkillCommands",
    "commands.enableClaudeUser",
    "commands.enableClaudeProject",
    "commands.enableOpencodeUser",
    "commands.enableOpencodeProject",
  ],
  [
    "task.isolation.enabled",
    "isolation.backend",
    "worktree.clone",
    "worktree.cleanSource",
    "task.isolation.apply",
    "task.isolation.merge",
    "task.isolation.commits",
    "worktree.base",
  ],
  [
    "goal.enabled",
    "goal.statusInFooter",
    "goal.continuationModes",
    "title.refreshOnReplan",
    "plan.enabled",
    "plan.defaultOnStartup",
    "plan.autosave",
    "plan.autosaveDir",
  ],
  [
    "task.eager",
    "task.batch",
    "task.speculativeLaunch",
    "task.enableEffort",
    "task.maxConcurrency",
    "task.enableLsp",
    "task.maxRecursionDepth",
    "task.maxRuntimeMs",
    "task.completionProbe",
    "task.agentIdleTtlMs",
    "task.softRequestBudget",
    "task.softRequestBudgetNotice",
    "task.maxEffort",
    "task.disabledAgents", // `task/settings.ts:384-388`
    "task.agentModelOverrides", // `task/settings.ts:19-20,391-395`
    "task.agentServiceTierOverrides", // `task/settings.ts:16,398-403`
    "task.agentCompactionThresholdOverrides", // `task/settings.ts:17,406-411`
    "task.agentPrewalk", // `task/settings.ts:414-418`
    "task.agentAdvisor", // `task/settings.ts:421-425`
    "task.prewalk",
    "task.showResolvedModelBadge", // `task/settings.ts:441-445`
  ],
] as const;

function control(key: string): SettingControl {
  const found = S3_SETTINGS_SECTIONS.flatMap((section) => section.controls).find(
    (candidate) => candidate.key === key,
  );
  if (!found) throw new Error(`Missing S3 setting ${key}`);
  return found;
}

function validate(key: string, value: SettingValue) {
  return control(key).validate(value, snapshot);
}

describe("S3 Tools and Tasks sections", () => {
  test("covers all fourteen S5 rows and exact registered keys", () => {
    expect(S3_SETTINGS_SECTIONS).toHaveLength(14);
    expect(S3_SETTINGS_SECTIONS.map((section) => section.inventory)).toEqual([
      ["S5.tools-available-tools"],
      ["S5.tools-grep-browser"],
      ["S5.tools-computer"],
      ["S5.tools-github"],
      ["S5.tools-output-limits"],
      ["S5.tools-execution"],
      ["S5.tools-extensions"],
      ["S5.tools-developer"],
      ["S5.tools-ida-pro"],
      ["S5.tools-todos"],
      ["S5.tasks-commands-skills"],
      ["S5.tasks-isolation"],
      ["S5.tasks-modes"],
      ["S5.tasks-subagents"],
    ]);
    expect(
      S3_SETTINGS_SECTIONS.map((section) => section.controls.map((control) => control.key)),
    ).toEqual(EXPECTED_KEYS);
    expect(S3_SETTINGS_SECTIONS.map((section) => section.requires)).toEqual(
      S3_SETTINGS_SECTIONS.map(() => ["host.config"]),
    );
  });

  test("validates bounds, enums, URLs, paths and arrays", () => {
    expect(validate("find.enabled", { secret: false, value: "auto" })).toEqual({ valid: true });
    expect(validate("find.enabled", { secret: false, value: "invalid" })).toMatchObject({
      valid: false,
      code: "enum",
    });
    expect(validate("grep.contextBefore", { secret: false, value: 2 })).toEqual({ valid: true });
    expect(validate("grep.contextBefore", { secret: false, value: -1 })).toMatchObject({
      valid: false,
      code: "range",
    });
    expect(validate("browser.cdpUrl", { secret: false, value: "https://127.0.0.1:9222" })).toEqual({
      valid: true,
    });
    expect(validate("browser.cdpUrl", { secret: false, value: "not a URL" })).toMatchObject({
      valid: false,
      code: "url",
    });
    expect(validate("worktree.base", { secret: false, value: "\0" })).toMatchObject({
      valid: false,
      code: "path",
    });
    expect(validate("task.maxRecursionDepth", { secret: false, value: -2 })).toMatchObject({
      valid: false,
      code: "range",
    });
    expect(validate("task.maxConcurrency", { secret: false, value: 32 })).toEqual({ valid: true });
    expect(validate("task.maxConcurrency", { secret: false, value: 1_001 })).toMatchObject({
      valid: false,
      code: "range",
    });
    expect(validate("goal.continuationModes", { secret: false, value: ["interactive"] })).toEqual({
      valid: true,
    });
  });

  test("marks tool/task runtime boundaries explicitly", () => {
    expect(control("tools.intentTracing").apply).toBe("live");
    expect(control("tools.outputMaxColumns").apply).toBe("live");
    expect(control("browser.headless").apply).toBe("restart");
    expect(control("computer.display").apply).toBe("restart");
    expect(control("task.isolation.apply").apply).toBe("restart");
    expect(control("plan.enabled").apply).toBe("session");
    expect(control("plan.defaultOnStartup").apply).toBe("restart");
    expect(control("task.maxConcurrency").apply).toBe("reload");
    expect(control("task.maxRuntimeMs").apply).toBe("session");
    expect(control("task.prewalk").apply).toBe("session");
  });
});
