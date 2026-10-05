import type { ShortcutAction, ShortcutRegistry } from "@/shortcuts/registry";
import { D1_SHORTCUT_DESCRIPTORS } from "./descriptors";

export type D1ShortcutActions = {
  readonly cycleModelBackward: ShortcutAction;
  readonly cycleModelForward: ShortcutAction;
  readonly selectModel: ShortcutAction;
  readonly selectTemporaryModel: ShortcutAction;
  readonly cycleThinking: ShortcutAction;
};

const ACTIONS: Readonly<Record<string, keyof D1ShortcutActions>> = {
  "D1.appModelCycleBackward": "cycleModelBackward",
  "D1.appModelCycleForward": "cycleModelForward",
  "D1.appModelSelect": "selectModel",
  "D1.appModelSelectTemporary": "selectTemporaryModel",
  "D1.appThinkingCycle": "cycleThinking",
};

/** Registers D1's actions through U0.6; no event listener or chord parser is duplicated here. */
export function registerD1ShortcutActions(
  registry: ShortcutRegistry,
  actions: D1ShortcutActions,
): () => void {
  const disposers = D1_SHORTCUT_DESCRIPTORS.map((descriptor) => {
    const actionName = ACTIONS[descriptor.id];
    if (!actionName) return () => undefined;
    return registry.registerAction(descriptor.id, actions[actionName]);
  });
  return () => {
    for (const dispose of disposers) dispose();
  };
}
