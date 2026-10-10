import type { CommandDescriptor, ShortcutDescriptor } from "@omp-app/contracts";

/** A shortcut that also fires while focus is in the composer: the app's opt-in (shortcuts/registry.ts). */
type EditableShortcutDescriptor = ShortcutDescriptor & { readonly allowInEditable: true };

/** omp's app.agents.hub (inventory P1.app-agents-hub, Alt+A): opens the Agent Hub. */
export const P1_AGENT_HUB_SHORTCUT = {
  kind: "shortcut",
  id: "P1.agentHubShortcut",
  owner: "P1",
  title: "Open the Agent Hub",
  covers: ["P1.app-agents-hub"],
  requires: [],
  chord: "Alt+A",
  scope: "global",
  allowInEditable: true,
} as const satisfies EditableShortcutDescriptor;

/** The palette's Agent Hub command. Its chord is the shortcut above, so the palette shows Alt+A. */
export const P1_AGENT_HUB_COMMAND = {
  kind: "command",
  id: "P1.agentHub",
  owner: "P1",
  title: "Agent Hub",
  covers: [],
  requires: [],
} as const satisfies CommandDescriptor;

export const P1_AGENT_HUB_DESCRIPTORS = [
  P1_AGENT_HUB_SHORTCUT,
  P1_AGENT_HUB_COMMAND,
] as const satisfies readonly (EditableShortcutDescriptor | CommandDescriptor)[];
