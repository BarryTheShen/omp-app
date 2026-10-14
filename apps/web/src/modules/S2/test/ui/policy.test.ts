import { AppFailure, type ConfigEntry, FolderPath, type JsonValue } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ConfigSnapshot, SettingsSectionDescriptor } from "../../../S1/settings-kit";
import { validate } from "../../../S1/settings-kit";
import {
  selectFilesLspPolicy,
  selectShellBashPolicy,
  selectShellEvalRuntimesPolicy,
} from "../../descriptors";
import { FILES_LSP_SECTION, SHELL_BASH_SECTION, SHELL_EVAL_RUNTIMES_SECTION } from "../../sections";
import { OMP_DEFAULTS, sectionSnapshot } from "./fixtures";

const SECTIONS = [FILES_LSP_SECTION, SHELL_BASH_SECTION, SHELL_EVAL_RUNTIMES_SECTION] as const;

/** The AppFailure a read throws; fails the test when the read returns instead. */
function failureOf(read: () => unknown): AppFailure {
  try {
    read();
  } catch (error) {
    if (error instanceof AppFailure) return error;
    throw error;
  }
  throw new Error("Expected the handoff to fail.");
}

/** A key, the typed field it feeds, and a value for the key that differs from omp's default. */
type KeyRow = readonly [key: string, field: string, value: JsonValue];

/** One key set away from its default, and the handoff that reads it. */
type HandoffCase = {
  readonly section: SettingsSectionDescriptor;
  readonly select: (snapshot: ConfigSnapshot) => {
    readonly values: Readonly<Record<string, unknown>>;
  };
  readonly key: string;
  readonly field: string;
  readonly value: JsonValue;
};

const LSP_ROWS: readonly KeyRow[] = [
  ["lsp.enabled", "enabled", false],
  ["lsp.lazy", "lazyStartup", false],
  ["lsp.shared", "sharedServers", false],
  ["lsp.formatOnWrite", "formatOnWrite", true],
  ["lsp.diagnosticsOnWrite", "diagnosticsOnWrite", false],
  ["lsp.diagnosticsOnEdit", "diagnosticsOnEdit", true],
  ["lsp.diagnosticsDeduplicate", "deduplicateDiagnostics", false],
];

const BASH_ROWS: readonly KeyRow[] = [
  ["bash.enabled", "enabled", false],
  ["bash.allowCompoundCommands", "allowCompoundCommands", true],
  ["bash.autoBackground.enabled", "autoBackground", false],
  ["bash.patterns", "approvalRules", [{ match: "git push *", approval: "deny" }]],
  ["bashInterceptor.enabled", "interceptor", true],
  ["bash.direnv", "direnv", "off"],
  ["bash.direnvLoadTimeoutMs", "direnvLoadTimeoutMs", 5000],
  ["shellMinimizer.enabled", "shellMinimizer", false],
  ["shellMinimizer.sourceOutlineLevel", "shellMinimizerOutline", "aggressive"],
];

const EVAL_ROWS: readonly KeyRow[] = [
  ["eval.py", "pythonBackend", false],
  ["eval.js", "javascriptBackend", false],
  ["eval.autoProvision", "autoProvision", false],
  ["eval.tools.enabled", "definedTools", false],
  ["eval.workpool.freshAgents", "freshWorkpoolAgents", true],
  ["eval.autoBackground.enabled", "autoBackground", true],
  ["python.kernelMode", "pythonKernelMode", "per-call"],
  ["python.interpreter", "pythonInterpreter", "/usr/bin/python3"],
];

function casesOf(
  section: SettingsSectionDescriptor,
  select: HandoffCase["select"],
  rows: readonly KeyRow[],
): readonly HandoffCase[] {
  return rows.map(([key, field, value]) => ({ section, select, key, field, value }));
}

const CASES: readonly HandoffCase[] = [
  ...casesOf(FILES_LSP_SECTION, selectFilesLspPolicy, LSP_ROWS),
  ...casesOf(SHELL_BASH_SECTION, selectShellBashPolicy, BASH_ROWS),
  ...casesOf(SHELL_EVAL_RUNTIMES_SECTION, selectShellEvalRuntimesPolicy, EVAL_ROWS),
];

describe("S2.4 typed policy handoffs", () => {
  test("every pinned omp default is a value its control accepts", () => {
    for (const section of SECTIONS) {
      const snapshot = sectionSnapshot(section);
      for (const control of section.controls) {
        const value = OMP_DEFAULTS[control.key];
        if (value === undefined) throw new Error(`No pinned omp default for ${control.key}.`);
        expect(validate(control, { secret: false, value }, snapshot), control.key).toEqual({
          valid: true,
        });
      }
    }
  });

  test("each handoff reads omp's defaults into typed values, with the folder and revision it was given", () => {
    const folder = FolderPath.parse("/workspace/app");
    expect(selectFilesLspPolicy(sectionSnapshot(FILES_LSP_SECTION, {}, folder))).toEqual({
      folder,
      revision: "handoff-revision-1",
      values: {
        enabled: true,
        lazyStartup: true,
        sharedServers: true,
        formatOnWrite: false,
        diagnosticsOnWrite: true,
        diagnosticsOnEdit: false,
        deduplicateDiagnostics: true,
      },
    });
    expect(selectShellBashPolicy(sectionSnapshot(SHELL_BASH_SECTION))).toEqual({
      folder: null,
      revision: "handoff-revision-1",
      values: {
        enabled: true,
        allowCompoundCommands: false,
        autoBackground: true,
        approvalRules: [],
        interceptor: false,
        direnv: "auto",
        direnvLoadTimeoutMs: 30_000,
        shellMinimizer: true,
        shellMinimizerOutline: "default",
      },
    });
    expect(selectShellEvalRuntimesPolicy(sectionSnapshot(SHELL_EVAL_RUNTIMES_SECTION))).toEqual({
      folder: null,
      revision: "handoff-revision-1",
      values: {
        pythonBackend: true,
        javascriptBackend: true,
        autoProvision: true,
        definedTools: true,
        freshWorkpoolAgents: false,
        autoBackground: false,
        pythonKernelMode: "session",
        pythonInterpreter: "",
      },
    });
  });

  test.each(CASES)("$key feeds only $field", ({ section, select, key, field, value }) => {
    const base = select(sectionSnapshot(section)).values;
    const changed = select(sectionSnapshot(section, { [key]: value })).values;
    const changedFields = Object.keys(base).filter(
      (name) => JSON.stringify(base[name]) !== JSON.stringify(changed[name]),
    );
    expect(changedFields).toEqual([field]);
  });

  test("every field of each handoff is fed by exactly one key in the table", () => {
    for (const section of SECTIONS) {
      const select = CASES.find((candidate) => candidate.section === section)?.select;
      if (!select) throw new Error(`No handoff cases for ${section.id}.`);
      const fields = Object.keys(select(sectionSnapshot(section)).values).sort();
      const fed = CASES.filter((candidate) => candidate.section === section)
        .map((candidate) => candidate.field)
        .sort();
      expect(fed, section.id).toEqual(fields);
    }
  });

  test("a key omp did not report, or a secret, fails the handoff as unavailable and names its section", () => {
    const snapshot = sectionSnapshot(FILES_LSP_SECTION);
    const withoutLazy = {
      ...snapshot,
      entries: snapshot.entries.filter((entry) => entry.key !== "lsp.lazy"),
    };
    expect(failureOf(() => selectFilesLspPolicy(withoutLazy)).appError).toEqual({
      code: "unavailable",
      message: "LSP settings are unavailable.",
      retryable: false,
    });

    const secretEntry: ConfigEntry = {
      key: "lsp.enabled",
      secret: true,
      isSet: true,
      source: "default",
      overrides: [],
    };
    const withSecret = {
      ...snapshot,
      entries: [...snapshot.entries.filter((entry) => entry.key !== "lsp.enabled"), secretEntry],
    };
    expect(failureOf(() => selectFilesLspPolicy(withSecret)).appError.code).toBe("unavailable");

    const bash = sectionSnapshot(SHELL_BASH_SECTION);
    const bashWithoutDirenv = {
      ...bash,
      entries: bash.entries.filter((entry) => entry.key !== "bash.direnv"),
    };
    expect(failureOf(() => selectShellBashPolicy(bashWithoutDirenv)).appError).toEqual({
      code: "unavailable",
      message: "Bash settings are unavailable.",
      retryable: false,
    });
  });

  test("a value of the wrong type or an unknown choice fails as invalid, and names its section", () => {
    expect(
      failureOf(() =>
        selectFilesLspPolicy(sectionSnapshot(FILES_LSP_SECTION, { "lsp.enabled": "yes" })),
      ).appError,
    ).toEqual({
      code: "invalid_args",
      message: "LSP settings have an invalid value.",
      retryable: false,
    });
    expect(
      failureOf(() =>
        selectShellBashPolicy(sectionSnapshot(SHELL_BASH_SECTION, { "bash.direnv": "maybe" })),
      ).appError,
    ).toEqual({
      code: "invalid_args",
      message: "Bash settings have an invalid value.",
      retryable: false,
    });
  });

  test("a value the control itself rejects fails as invalid with the control's words", () => {
    expect(
      failureOf(() =>
        selectShellBashPolicy(
          sectionSnapshot(SHELL_BASH_SECTION, { "bash.direnvLoadTimeoutMs": 700_000 }),
        ),
      ).appError,
    ).toMatchObject({ code: "invalid_args" });
    expect(
      failureOf(() =>
        selectShellBashPolicy(
          sectionSnapshot(SHELL_BASH_SECTION, {
            "bash.patterns": [{ match: " ", approval: "allow" }],
          }),
        ),
      ).appError,
    ).toEqual({
      code: "invalid_args",
      message: "Each rule needs a command pattern and an approval.",
      retryable: false,
    });
  });
});
