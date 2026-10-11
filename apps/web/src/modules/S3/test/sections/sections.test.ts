import { describe, expect, test } from "vitest";
import type { ConfigSnapshot, SettingControl, SettingValue } from "../../../S1/settings-kit";
import { S3_SETTINGS_SECTIONS } from "../../sections";
import { TOOLS_SETTINGS_SECTIONS } from "../../tools";

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

const LIVE_TOOLS_SETTINGS = [
  {
    key: "find.enabled",
    source:
      "packages/coding-agent/src/tools/settings.ts:1014-1045; packages/coding-agent/src/tools/jfind/index.ts:47",
  },
  {
    key: "tools.speculativeExecution.enabled",
    source:
      "packages/coding-agent/src/sdk.ts:4237-4242; packages/coding-agent/src/speculation/host.ts:125,331",
  },
  {
    key: "tools.speculativeExecution.maxInFlight",
    source:
      "packages/coding-agent/src/sdk.ts:4237-4242; packages/coding-agent/src/speculation/host.ts:125,331",
  },
  { key: "async.maxJobs", source: "packages/coding-agent/src/sdk.ts:2124-2128" },
  { key: "computer.display", source: "packages/coding-agent/src/tools/computer.ts:240-251" },
  { key: "computer.maxWidth", source: "packages/coding-agent/src/tools/computer.ts:240-251" },
  { key: "computer.maxHeight", source: "packages/coding-agent/src/tools/computer.ts:240-251" },
  {
    key: "ida.python",
    source:
      "packages/coding-agent/src/ida/runtime.ts:46; packages/coding-agent/src/ida/client.ts:320",
  },
  {
    key: "ida.installDir",
    source:
      "packages/coding-agent/src/ida/runtime.ts:46; packages/coding-agent/src/ida/install.ts:91",
  },
  { key: "ida.maxOpen", source: "packages/coding-agent/src/ida/client.ts:320" },
  { key: "ida.idleCloseSec", source: "packages/coding-agent/src/ida/client.ts:350" },
  {
    key: "github.cache.softTtlSec",
    source: "packages/coding-agent/src/tools/github-cache.ts:488-490",
  },
  {
    key: "github.cache.hardTtlSec",
    source: "packages/coding-agent/src/tools/github-cache.ts:488-490",
  },
  {
    key: "images.questionTimeoutMs",
    source: "packages/coding-agent/src/utils/image-question.ts:114",
  },
  {
    key: "extensionHandlers.toolCallTimeoutMs",
    source: "packages/coding-agent/src/extensibility/extensions/runner.ts:1819-1821",
  },
  {
    key: "dev.autoqaPush.endpoint",
    source: "packages/coding-agent/src/tools/report-tool-issue.ts:385",
  },
  {
    key: "todo.eager",
    source: "packages/coding-agent/src/session/todo-tracker.ts:140",
  },
  {
    key: "browser.cdpUrl",
    source: "packages/coding-agent/src/tools/browser.ts:179-209",
  },
  {
    key: "browser.relay",
    source:
      "packages/coding-agent/src/tools/browser.ts:179-209; packages/coding-agent/src/tools/browser/relay/kind.ts:31-46",
  },
  {
    key: "browser.relayUrl",
    source: "packages/coding-agent/src/tools/browser.ts:179-209",
  },
  {
    key: "browser.screenshotDir",
    source: "packages/coding-agent/src/tools/browser/tab-supervisor.ts:1735",
  },
  {
    key: "browser.headless",
    source: "packages/coding-agent/src/tools/browser.ts:214-231",
  },
  {
    key: "browser.cmux",
    source: "packages/coding-agent/src/tools/browser.ts:179-231",
  },
  {
    key: "browser.tern",
    source: "packages/coding-agent/src/tools/browser.ts:179-231",
  },
] as const;

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

  test("uses distinct, described labels, human-readable options, and explicit units", () => {
    for (const section of S3_SETTINGS_SECTIONS) {
      const labels = section.controls.map((item) => item.label);
      expect(labels.every((label) => label.trim().length > 0)).toBe(true);
      expect(new Set(labels).size).toBe(labels.length);
      for (const item of section.controls) {
        expect(item.description?.trim().length).toBeGreaterThan(0);
        if (item.kind === "enum") {
          for (const option of item.options ?? []) {
            expect(option.label).not.toBe(option.value);
          }
        }
      }
    }

    for (const [key, unit] of Object.entries({
      "grep.contextBefore": "(lines)",
      "grep.contextAfter": "(lines)",
      "browser.idleCloseSec": "(seconds)",
      "computer.maxWidth": "(pixels)",
      "computer.maxHeight": "(pixels)",
      "github.cache.softTtlSec": "(seconds)",
      "github.cache.hardTtlSec": "(seconds)",
      "tools.artifactSpillThreshold": "(KB)",
      "tools.artifactTailBytes": "(KB)",
      "tools.artifactHeadBytes": "(KB)",
      "tools.outputMaxColumns": "(bytes)",
      "tools.artifactMaxBytes": "(MB)",
      "images.questionTimeoutMs": "(ms)",
      "tools.maxTimeout": "(seconds)",
      "async.maxJobs": "Jobs",
      "extensionHandlers.toolCallTimeoutMs": "(ms)",
      "ida.idleCloseSec": "(seconds)",
      "tasks.todoClearDelay": "(seconds)",
      "task.maxRuntimeMs": "(ms)",
      "task.agentIdleTtlMs": "(ms)",
    })) {
      expect(control(key).label).toContain(unit);
    }
    // A count word would repeat the noun, so these labels name no unit: the noun already says what is counted.
    for (const key of [
      "tools.artifactTailLines",
      "tools.speculativeExecution.maxInFlight",
      "todo.remindersMax",
      "task.maxConcurrency",
      "task.maxRecursionDepth",
      "task.softRequestBudget",
    ]) {
      expect(control(key).label).not.toMatch(
        /\((lines|operations|reminders|tasks|levels|requests)\)$/,
      );
    }
  });

  test("says in the description when only omp's terminal or editor sessions read a setting", () => {
    for (const key of ["tasks.todoClearDelay", "goal.statusInFooter", "plan.defaultOnStartup"]) {
      expect(control(key).description, key).toContain("Used by omp's terminal only.");
    }
    for (const key of ["plan.autosave", "plan.autosaveDir"]) {
      expect(control(key).description, key).toContain(
        "Used by omp's terminal and editor sessions only.",
      );
    }
  });

  test("gives the extension tool-call timeout its plain description", () => {
    expect(control("extensionHandlers.toolCallTimeoutMs").description).toBe(
      "How long an extension's tool-call handler may work before it is stopped. A value that is not above 0 uses 30,000 ms; time spent waiting for a dialog does not count.",
    );
  });

  test("marks every v18.6.1 Tools control as live", () => {
    for (const { key, source } of LIVE_TOOLS_SETTINGS) {
      expect(control(key).apply, `${key}: ${source}`).toBe("live");
    }
    const toolsControls = TOOLS_SETTINGS_SECTIONS.flatMap((section) => section.controls);
    expect(toolsControls).toHaveLength(64);
    for (const setting of toolsControls) {
      expect(setting.apply, `${setting.key}: every Tools setting is live`).toBe("live");
    }
  });

  test("validates bounds, enums, URLs, paths and arrays", () => {
    expect(validate("find.enabled", { secret: false, value: "auto" })).toEqual({ valid: true });
    expect(validate("find.enabled", { secret: false, value: "invalid" })).toMatchObject({
      valid: false,
      code: "enum",
    });
    expect(validate("async.maxJobs", { secret: false, value: 0 })).toEqual({ valid: true });
    expect(validate("async.maxJobs", { secret: false, value: 100 })).toEqual({ valid: true });
    expect(validate("async.maxJobs", { secret: false, value: 101 })).toMatchObject({
      valid: false,
      code: "range",
    });
    expect(validate("extensionHandlers.toolCallTimeoutMs", { secret: false, value: 1 })).toEqual({
      valid: true,
    });
    expect(
      validate("extensionHandlers.toolCallTimeoutMs", { secret: false, value: 0 }),
    ).toMatchObject({ valid: false, code: "range" });
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
    expect(control("browser.headless").apply).toBe("live");
    expect(control("computer.display").apply).toBe("live");
    expect(control("plan.enabled").apply).toBe("session");
    expect(control("plan.defaultOnStartup").apply).toBe("restart");
    expect(control("task.maxConcurrency").apply).toBe("reload");
    expect(control("task.maxRuntimeMs").apply).toBe("session");
    expect(control("task.prewalk").apply).toBe("session");
  });
});

describe("S3 section titles", () => {
  test("each title is omp v18.6.1's group label (with and for &), in the order the sections list", () => {
    expect(S3_SETTINGS_SECTIONS.map((section) => section.title)).toEqual([
      "Available Tools",
      "Grep and Browser",
      "Computer",
      "GitHub",
      "Output Limits",
      "Execution",
      "Extensions",
      "Developer",
      "IDA Pro",
      "Todos",
      "Commands and Skills",
      "Isolation",
      "Modes",
      "Subagents",
    ]);
  });
});
