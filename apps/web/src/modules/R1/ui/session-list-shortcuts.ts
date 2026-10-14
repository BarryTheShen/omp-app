import { useEffect, useLayoutEffect, useRef } from "react";
import { useShortcutRegistry, useShortcutScope } from "@/shortcuts";
import { R1_SESSION_LIST_SCOPE } from "../descriptors/descriptors";

/** What the session list's chords do to the chat the keyboard is on. */
export interface SessionListShortcutActions {
  readonly rename: () => void;
  readonly deleteAfterConfirmation: () => Promise<void>;
  readonly deleteWithoutConfirmation: () => Promise<void>;
}

/**
 * Registers the session list's chords: F2 renames the chat, Mod+Shift+Backspace deletes it after the
 * confirmation, and Mod+Backspace deletes it at once. The descriptors' focus scope is the list element,
 * so a chord acts only while focus is inside the list. Two lists can be mounted (the sidebar and the
 * open-session dialog): the registry runs the newest one, and the one under it when that one unmounts.
 */
export function useSessionListShortcuts(actions: SessionListShortcutActions): void {
  const registry = useShortcutRegistry();
  useShortcutScope(R1_SESSION_LIST_SCOPE);
  // The chords act on the list as it is when a key is pressed, so the registration is made once per registry. The list
  // is read in a layout effect: a passive effect can run after the rows are already on screen, and a key pressed in
  // that gap would act on the list before them (issue 1538, seen under load).
  const latest = useRef(actions);
  useLayoutEffect(() => {
    latest.current = actions;
  });
  useEffect(() => {
    const disposers = [
      registry.registerAction("R1.sessionRename", () => latest.current.rename()),
      registry.registerAction("R1.sessionDelete", () => latest.current.deleteAfterConfirmation()),
      registry.registerAction("R1.sessionDeleteNoninvasive", () =>
        latest.current.deleteWithoutConfirmation(),
      ),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [registry]);
}
