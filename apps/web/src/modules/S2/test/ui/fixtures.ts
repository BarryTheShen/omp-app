import type { ConfigEntry, FolderPath, JsonValue } from "@omp-app/contracts";
import type { ConfigSnapshot, SettingsSectionDescriptor } from "../../../S1/settings-kit";

/**
 * omp v18.8.9's registered default for each key the Files / LSP, Shell / Bash and Shell / Eval & Runtimes sections
 * show. Each comment gives the `id:` line of the register() call in omp's packages/coding-agent/src.
 */
export const OMP_DEFAULTS: Readonly<Record<string, JsonValue>> = {
  // lsp/settings.ts:9, 21, 34, 47, 59, 71, 83
  "lsp.enabled": true,
  "lsp.lazy": true,
  "lsp.shared": true,
  "lsp.formatOnWrite": false,
  "lsp.diagnosticsOnWrite": true,
  "lsp.diagnosticsOnEdit": false,
  "lsp.diagnosticsDeduplicate": true,
  // lsp/settings.ts v18.12.2:94-113
  "lsp.requestTimeout": 10,
  // exec/settings.ts:83, 95, 108, 134, 148, 166, 180, 194, 230
  "bash.enabled": true,
  "bash.allowCompoundCommands": false,
  "bash.autoBackground.enabled": true,
  "bash.gitGuard": false,
  "bash.patterns": [],
  "bashInterceptor.enabled": false,
  "bash.direnv": "auto",
  "bash.direnvLoadTimeoutMs": 30_000,
  "shellMinimizer.enabled": true,
  "shellMinimizer.sourceOutlineLevel": "default",
  // eval/settings.ts:9, 22, 35, 47, 60, 72, 93, 106
  "eval.py": true,
  "eval.js": true,
  "eval.autoProvision": true,
  "eval.tools.enabled": true,
  "eval.workpool.freshAgents": false,
  "eval.autoBackground.enabled": false,
  "python.kernelMode": "session",
  "python.interpreter": "",
};

/**
 * A ConfigStore snapshot of one section: each control's entry at omp's default, with the overridden values in place.
 * The handoffs do not read an entry's source, so every entry is marked "default".
 */
export function sectionSnapshot(
  descriptor: SettingsSectionDescriptor,
  overrides: Readonly<Record<string, JsonValue>> = {},
  folder: FolderPath | null = null,
): ConfigSnapshot {
  const values: Readonly<Record<string, JsonValue>> = { ...OMP_DEFAULTS, ...overrides };
  const entries = descriptor.controls.map((control): ConfigEntry => {
    const value = values[control.key];
    if (value === undefined) throw new Error(`No pinned omp default for ${control.key}.`);
    return { key: control.key, secret: false, value, source: "default", overrides: [] };
  });
  return { folder, revision: "handoff-revision-1", entries };
}
