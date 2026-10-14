import type { FolderPath, Revision } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { z } from "zod";
import type { ConfigSnapshot, SettingsSectionDescriptor } from "../../S1/settings-kit";
import { effectiveEntry, validate } from "../../S1/settings-kit";
import { FILES_LSP_SECTION, SHELL_BASH_SECTION, SHELL_EVAL_RUNTIMES_SECTION } from "../sections";

/*
 * Typed policy handoffs for the consumers that act on these settings: search and code intelligence (T2) reads Files /
 * LSP, and execution (T3) reads Shell / Bash and Shell / Eval & Runtimes. File consumers (T1) read ../files/policy.ts.
 * Each selector reads one section's ConfigStore snapshot and checks every value against its control. An entry omp did
 * not report, a secret, or a value the control rejects is a typed AppFailure; the handoff never supplies a default of
 * its own (S2 README, Rules: a missing capability is unavailable, not emulated).
 */

const booleanSchema = z.boolean();
const textSchema = z.string();
const finiteNumberSchema = z.number().finite();
const bashDirenvSchema = z.enum(["auto", "off"]);
const shellOutlineSchema = z.enum(["default", "aggressive"]);
const pythonKernelModeSchema = z.enum(["session", "per-call"]);
const bashApprovalRuleSchema = z.object({
  match: textSchema,
  approval: z.enum(["allow", "deny", "prompt"]),
});

export type BashDirenvMode = z.infer<typeof bashDirenvSchema>;
export type ShellOutlineLevel = z.infer<typeof shellOutlineSchema>;
export type PythonKernelMode = z.infer<typeof pythonKernelModeSchema>;
export type BashApprovalRule = z.infer<typeof bashApprovalRuleSchema>;

export type FilesLspPolicy = {
  readonly enabled: boolean;
  readonly lazyStartup: boolean;
  readonly sharedServers: boolean;
  readonly formatOnWrite: boolean;
  readonly diagnosticsOnWrite: boolean;
  readonly diagnosticsOnEdit: boolean;
  readonly deduplicateDiagnostics: boolean;
};

export type FilesLspPolicySnapshot = {
  readonly folder: FolderPath | null;
  readonly revision: Revision;
  readonly values: FilesLspPolicy;
};

export type ShellBashPolicy = {
  readonly enabled: boolean;
  readonly allowCompoundCommands: boolean;
  readonly autoBackground: boolean;
  /** Ordered: the first rule whose pattern matches decides; omp drops a rule with an empty pattern. */
  readonly approvalRules: readonly BashApprovalRule[];
  readonly interceptor: boolean;
  readonly direnv: BashDirenvMode;
  readonly direnvLoadTimeoutMs: number;
  readonly shellMinimizer: boolean;
  readonly shellMinimizerOutline: ShellOutlineLevel;
};

export type ShellBashPolicySnapshot = {
  readonly folder: FolderPath | null;
  readonly revision: Revision;
  readonly values: ShellBashPolicy;
};

export type ShellEvalRuntimesPolicy = {
  readonly pythonBackend: boolean;
  readonly javascriptBackend: boolean;
  readonly autoProvision: boolean;
  readonly definedTools: boolean;
  readonly freshWorkpoolAgents: boolean;
  readonly autoBackground: boolean;
  readonly pythonKernelMode: PythonKernelMode;
  readonly pythonInterpreter: string;
};

export type ShellEvalRuntimesPolicySnapshot = {
  readonly folder: FolderPath | null;
  readonly revision: Revision;
  readonly values: ShellEvalRuntimesPolicy;
};

function policyValue<T>(
  descriptor: SettingsSectionDescriptor,
  snapshot: ConfigSnapshot,
  key: string,
  schema: z.ZodType<T>,
): T {
  const control = descriptor.controls.find((candidate) => candidate.key === key);
  const entry = effectiveEntry(snapshot, key);
  if (!control || entry === undefined || entry.secret) {
    throw new AppFailure({
      code: "unavailable",
      message: `${descriptor.title} settings are unavailable.`,
      retryable: false,
    });
  }
  const parsed = schema.safeParse(entry.value);
  if (!parsed.success) {
    throw new AppFailure({
      code: "invalid_args",
      message: `${descriptor.title} settings have an invalid value.`,
      retryable: false,
    });
  }
  const result = validate(control, { secret: false, value: entry.value }, snapshot);
  if (!result.valid) {
    throw new AppFailure({ code: "invalid_args", message: result.message, retryable: false });
  }
  return parsed.data;
}

export function selectFilesLspPolicy(snapshot: ConfigSnapshot): FilesLspPolicySnapshot {
  return {
    folder: snapshot.folder,
    revision: snapshot.revision,
    values: {
      enabled: policyValue(FILES_LSP_SECTION, snapshot, "lsp.enabled", booleanSchema),
      lazyStartup: policyValue(FILES_LSP_SECTION, snapshot, "lsp.lazy", booleanSchema),
      sharedServers: policyValue(FILES_LSP_SECTION, snapshot, "lsp.shared", booleanSchema),
      formatOnWrite: policyValue(FILES_LSP_SECTION, snapshot, "lsp.formatOnWrite", booleanSchema),
      diagnosticsOnWrite: policyValue(
        FILES_LSP_SECTION,
        snapshot,
        "lsp.diagnosticsOnWrite",
        booleanSchema,
      ),
      diagnosticsOnEdit: policyValue(
        FILES_LSP_SECTION,
        snapshot,
        "lsp.diagnosticsOnEdit",
        booleanSchema,
      ),
      deduplicateDiagnostics: policyValue(
        FILES_LSP_SECTION,
        snapshot,
        "lsp.diagnosticsDeduplicate",
        booleanSchema,
      ),
    },
  };
}

export function selectShellBashPolicy(snapshot: ConfigSnapshot): ShellBashPolicySnapshot {
  return {
    folder: snapshot.folder,
    revision: snapshot.revision,
    values: {
      enabled: policyValue(SHELL_BASH_SECTION, snapshot, "bash.enabled", booleanSchema),
      allowCompoundCommands: policyValue(
        SHELL_BASH_SECTION,
        snapshot,
        "bash.allowCompoundCommands",
        booleanSchema,
      ),
      autoBackground: policyValue(
        SHELL_BASH_SECTION,
        snapshot,
        "bash.autoBackground.enabled",
        booleanSchema,
      ),
      approvalRules: policyValue(
        SHELL_BASH_SECTION,
        snapshot,
        "bash.patterns",
        z.array(bashApprovalRuleSchema),
      ),
      interceptor: policyValue(
        SHELL_BASH_SECTION,
        snapshot,
        "bashInterceptor.enabled",
        booleanSchema,
      ),
      direnv: policyValue(SHELL_BASH_SECTION, snapshot, "bash.direnv", bashDirenvSchema),
      direnvLoadTimeoutMs: policyValue(
        SHELL_BASH_SECTION,
        snapshot,
        "bash.direnvLoadTimeoutMs",
        finiteNumberSchema,
      ),
      shellMinimizer: policyValue(
        SHELL_BASH_SECTION,
        snapshot,
        "shellMinimizer.enabled",
        booleanSchema,
      ),
      shellMinimizerOutline: policyValue(
        SHELL_BASH_SECTION,
        snapshot,
        "shellMinimizer.sourceOutlineLevel",
        shellOutlineSchema,
      ),
    },
  };
}

export function selectShellEvalRuntimesPolicy(
  snapshot: ConfigSnapshot,
): ShellEvalRuntimesPolicySnapshot {
  return {
    folder: snapshot.folder,
    revision: snapshot.revision,
    values: {
      pythonBackend: policyValue(SHELL_EVAL_RUNTIMES_SECTION, snapshot, "eval.py", booleanSchema),
      javascriptBackend: policyValue(
        SHELL_EVAL_RUNTIMES_SECTION,
        snapshot,
        "eval.js",
        booleanSchema,
      ),
      autoProvision: policyValue(
        SHELL_EVAL_RUNTIMES_SECTION,
        snapshot,
        "eval.autoProvision",
        booleanSchema,
      ),
      definedTools: policyValue(
        SHELL_EVAL_RUNTIMES_SECTION,
        snapshot,
        "eval.tools.enabled",
        booleanSchema,
      ),
      freshWorkpoolAgents: policyValue(
        SHELL_EVAL_RUNTIMES_SECTION,
        snapshot,
        "eval.workpool.freshAgents",
        booleanSchema,
      ),
      autoBackground: policyValue(
        SHELL_EVAL_RUNTIMES_SECTION,
        snapshot,
        "eval.autoBackground.enabled",
        booleanSchema,
      ),
      pythonKernelMode: policyValue(
        SHELL_EVAL_RUNTIMES_SECTION,
        snapshot,
        "python.kernelMode",
        pythonKernelModeSchema,
      ),
      pythonInterpreter: policyValue(
        SHELL_EVAL_RUNTIMES_SECTION,
        snapshot,
        "python.interpreter",
        textSchema,
      ),
    },
  };
}
