import type { SettingsRuntime } from "../../S1/runtime";
import { RuntimeSettingsSection } from "../lsp/settings-section";

export function ShellBashSection({ runtime }: { readonly runtime: SettingsRuntime }) {
  return (
    <RuntimeSettingsSection
      runtime={runtime}
      behaviorNote="Bash settings are read for each new command. Saving does not interrupt a command or restart a running shell."
    />
  );
}

export function ShellEvalRuntimesSection({ runtime }: { readonly runtime: SettingsRuntime }) {
  return (
    <RuntimeSettingsSection
      runtime={runtime}
      behaviorNote="Backend, provisioning, and kernel choices are read for relevant new operations; workpool policy is selected for each new pool. Saving never kills an active Python kernel or workpool, which keep their current state until normal cleanup."
    />
  );
}
