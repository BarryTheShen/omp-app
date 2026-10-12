import { normalizeChord, type ShortcutDescriptor } from "@omp-app/contracts";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect } from "react";
import { useShortcutRegistry } from "../../../shortcuts";
import type { ShortcutAction, ShortcutRegistry } from "../../../shortcuts/registry";
import { U2Descriptors } from "../descriptors/descriptors";

/** omp v18.6.1's external-editor chord is Ctrl+G; Mod maps it to Cmd on macOS. See `src/modes/controllers/input-controller.ts:2084-2110`. */
export const U2_EXTERNAL_EDITOR_SHORTCUT = {
  kind: "shortcut",
  id: "U2.externalEditorShortcut",
  owner: "U2",
  title: "Open external editor",
  covers: [],
  requires: [],
  chord: "Mod+G",
  scope: "composer-input",
  allowInEditable: true,
  focus: "composer-input",
} as const satisfies ShortcutDescriptor & {
  readonly allowInEditable: true;
  readonly focus: "composer-input";
};

export interface ComposerShortcutActions {
  readonly externalEditor?: ShortcutAction;
  readonly historySearch?: ShortcutAction;
}

/** Registers U2 actions with U0.6; P6's follow-up chord is intentionally not claimed here. */
export function registerComposerShortcutActions(
  registry: ShortcutRegistry,
  actions: ComposerShortcutActions,
): () => void {
  const disposers: Array<() => void> = [];
  if (actions.externalEditor !== undefined) {
    disposers.push(registry.registerAction(U2_EXTERNAL_EDITOR_SHORTCUT.id, actions.externalEditor));
  }
  if (actions.historySearch !== undefined) {
    const descriptor = U2Descriptors.find(
      (candidate): candidate is ShortcutDescriptor =>
        candidate.kind === "shortcut" && candidate.id === "U2.historySearchShortcut",
    );
    if (descriptor !== undefined) {
      disposers.push(registry.registerAction(descriptor.id, actions.historySearch));
    }
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}

function keyName(event: KeyboardEvent): string {
  if (event.key === " ") return "Space";
  if (event.key === "Escape") return "Esc";
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key;
}
function eventChord(event: KeyboardEvent): string {
  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push("Mod");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return [...modifiers, keyName(event)].join("+");
}

/** Capture-phase dispatcher for editable composer targets; U0.6's global dispatcher intentionally yields there. */
export function ComposerShortcutScope({
  children,
  registry,
  actions,
  scope,
}: {
  readonly children: ReactNode;
  readonly registry: ShortcutRegistry;
  readonly actions: ComposerShortcutActions;
  readonly scope?: string;
}) {
  useEffect(() => registerComposerShortcutActions(registry, actions), [actions, registry]);
  const handleKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    const normalized = normalizeChord(eventChord(event.nativeEvent));
    const binding = registry
      .bindings()
      .find(
        (candidate) =>
          (scope === undefined || candidate.scope === scope) &&
          candidate.normalizedChord === normalized,
      );
    if (binding === undefined) return;
    const action =
      binding.id === U2_EXTERNAL_EDITOR_SHORTCUT.id
        ? actions.externalEditor
        : binding.id === "U2.historySearchShortcut"
          ? actions.historySearch
          : undefined;
    if (action === undefined) return;
    event.preventDefault();
    void action();
  };
  return <div onKeyDownCapture={handleKeyDownCapture}>{children}</div>;
}

export function useComposerShortcutRegistry(): ShortcutRegistry {
  return useShortcutRegistry();
}
