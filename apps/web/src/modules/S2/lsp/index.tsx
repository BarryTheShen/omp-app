import type { SettingsRuntime } from "../../S1/runtime";
import { RuntimeSettingsSection } from "./settings-section";

export function FilesLspSection({ runtime }: { readonly runtime: SettingsRuntime }) {
  return (
    <RuntimeSettingsSection
      runtime={runtime}
      behaviorNote="LSP enablement is checked for future calls, but server discovery and startup warm-up only run when a session starts. Saving never stops or reconnects a running language server. New language-server sessions use the saved shared-server mode; already-running ones keep their transport until they exit or go idle. Turning Lazy LSP Startup off during a session starts warm-up; turning it back on does not stop servers already started."
    />
  );
}
