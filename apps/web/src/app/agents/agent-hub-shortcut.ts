import { useEffect } from "react";
import { P1_AGENT_HUB_COMMAND, P1_AGENT_HUB_SHORTCUT } from "@/modules/P1/hub/descriptors";
import { useShortcutRegistry } from "@/shortcuts";

/** Opens the Agent Hub from the palette ("Agent Hub") and from Alt+A (omp's app.agents.hub). */
export function useAgentHubShortcut(open: () => void): void {
  const registry = useShortcutRegistry();
  useEffect(() => {
    const unregisterCommand = registry.registerCommand(P1_AGENT_HUB_COMMAND.id, {
      run: open,
      shortcut: P1_AGENT_HUB_SHORTCUT.id,
    });
    const unregisterShortcut = registry.registerAction(P1_AGENT_HUB_SHORTCUT.id, open);
    return () => {
      unregisterCommand();
      unregisterShortcut();
    };
  }, [open, registry]);
}
