import type { SettingsRuntime } from "../../S1/runtime";
import { RuntimeSettingsSection } from "./settings-section";

export { RuntimeSettingsSection } from "./settings-section";

export function FilesLspSection({ runtime }: { readonly runtime: SettingsRuntime }) {
  return <RuntimeSettingsSection runtime={runtime} />;
}
