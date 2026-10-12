import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import { useShortcutRegistry, useShortcutScope } from "@/shortcuts";
import type { ShortcutAction, ShortcutRegistry } from "@/shortcuts/registry";
import { useTranscriptDisplayPolicy } from "../policy/policy";
import { U1ShortcutDescriptors } from "../registry/shortcuts";

export interface U1ShortcutActions {
  readonly resetDisplay: ShortcutAction;
  readonly toggleThinking: ShortcutAction;
  readonly toggleToolExpansion: ShortcutAction;
  readonly toggleToolVisibility: ShortcutAction;
}

export interface TranscriptShortcutScopeProps {
  readonly actions: U1ShortcutActions;
  readonly children: ReactNode;
}

type U1ShortcutId = (typeof U1ShortcutDescriptors)[number]["id"];

const ACTION_BY_ID: Readonly<Record<U1ShortcutId, keyof U1ShortcutActions>> = {
  "U1.appDisplayReset": "resetDisplay",
  "U1.thinking.toggle": "toggleThinking",
  "U1.appToolsExpand": "toggleToolExpansion",
  "U1.appToolsToggleVisibility": "toggleToolVisibility",
};

/** Registers U1 behavior through U0; callers provide display reset without coupling to U1.8. */
export function registerU1ShortcutActions(
  registry: ShortcutRegistry,
  actions: U1ShortcutActions,
): () => void {
  const disposers = U1ShortcutDescriptors.map((descriptor) =>
    registry.registerAction(descriptor.id, actions[ACTION_BY_ID[descriptor.id]]),
  );
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** Activates U1's transcript scope while the caller-provided transcript surface is mounted. */
export function TranscriptShortcutScope({ actions, children }: TranscriptShortcutScopeProps) {
  const registry = useShortcutRegistry();
  useShortcutScope("transcript");
  useEffect(() => registerU1ShortcutActions(registry, actions), [actions, registry]);
  return <>{children}</>;
}

interface TranscriptShortcutsProps {
  /** Jumps the transcript to its latest message (the thread's scroll controller). */
  readonly followLatest: () => void;
  readonly children: ReactNode;
}

/**
 * The transcript's shortcuts, wired to the display policy above it: Alt+T shows or hides thinking, Mod+O opens or
 * collapses every tool call, Mod+Shift+O shows or hides tool activity, and Alt+L jumps to the latest message.
 */
export function TranscriptShortcuts({ followLatest, children }: TranscriptShortcutsProps) {
  const { toggleThinking, toggleTools, toggleExpandTools } = useTranscriptDisplayPolicy();
  const actions = useMemo<U1ShortcutActions>(
    () => ({
      resetDisplay: followLatest,
      toggleThinking,
      toggleToolExpansion: toggleExpandTools,
      toggleToolVisibility: toggleTools,
    }),
    [followLatest, toggleExpandTools, toggleThinking, toggleTools],
  );
  return <TranscriptShortcutScope actions={actions}>{children}</TranscriptShortcutScope>;
}
