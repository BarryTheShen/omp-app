import type { SettingsRuntime } from "../../S1/runtime";
import { RuntimeSettingsSection } from "../lsp/settings-section";

export function ShellBashSection({ runtime }: { readonly runtime: SettingsRuntime }) {
  return <RuntimeSettingsSection runtime={runtime} />;
}

export function ShellEvalRuntimesSection({ runtime }: { readonly runtime: SettingsRuntime }) {
  return <RuntimeSettingsSection runtime={runtime} />;
}
