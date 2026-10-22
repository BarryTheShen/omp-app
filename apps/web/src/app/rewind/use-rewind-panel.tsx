import type { CapabilityMap, DescriptorId, RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Surface } from "@/layout";
import type { ConversationTransitionPort } from "@/modules/P4/transitions";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { useShortcutRegistry } from "@/shortcuts";
import { RewindPanel } from "./rewind-panel";
import { REWIND_CAPABILITIES, rewindAvailable } from "./rewind-tree";

/** P4's palette command and shortcut that open the rewind tree (`modules/P4/contract/descriptors.ts`). */
const REWIND_COMMAND: DescriptorId = "P4.treeCommand";
const REWIND_SHORTCUT: DescriptorId = "P4.sessionTree";
const COMPOSER_INPUT = 'textarea[aria-label="Message input"]';

export interface RewindPanelOptions {
  readonly threadId: ThreadId;
  readonly store: OmpRuntimeStore;
  readonly send: RpcSessionSend;
  readonly capabilities: CapabilityMap;
  readonly transitions: ConversationTransitionPort;
}

/**
 * The rewind tree as a right-hand panel. The layout lists the returned surface only while it is
 * open, and only while omp has the commands it needs. While those are available, the palette
 * command and the chord open the panel; Escape closes it and focus returns to where it was opened
 * from, which is the last thing focused outside any dialog.
 */
export function useRewindPanel({
  threadId,
  store,
  send,
  capabilities,
  transitions,
}: RewindPanelOptions): Surface {
  const shortcuts = useShortcutRegistry();
  const available = rewindAvailable(capabilities);
  const [panel, setPanel] = useState({ open: false, reveal: 0 });
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const lastFocused = useRef<HTMLElement | null>(null);
  const openedFrom = useRef<HTMLElement | null>(null);
  const shownThread = useRef(threadId);

  // The element focused last outside every dialog and outside the panel: where a panel opened from.
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('[role="dialog"], [data-rewind-panel="true"]') !== null) return;
      lastFocused.current = target;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);

  const open = useCallback(() => {
    if (!panelRef.current.open) openedFrom.current = lastFocused.current;
    setPanel((current) => ({ open: true, reveal: current.reveal + 1 }));
  }, []);

  const close = useCallback(() => {
    const opened = openedFrom.current;
    const currentComposer = document.querySelector<HTMLTextAreaElement>(COMPOSER_INPUT);
    const target = opened?.isConnected ? opened : currentComposer;
    openedFrom.current = null;
    setPanel((current) => ({ ...current, open: false }));
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, []);

  // A rewind switches the conversation; the tree on screen belongs to the one it left.
  useEffect(() => {
    if (shownThread.current === threadId) return;
    shownThread.current = threadId;
    if (panelRef.current.open) close();
  }, [close, threadId]);

  // The command and the chord exist only while omp has the commands the panel needs.
  useEffect(() => {
    if (!available) return;
    const unregisterCommand = shortcuts.registerCommand(REWIND_COMMAND, {
      run: open,
      shortcut: REWIND_SHORTCUT,
    });
    const unregisterShortcut = shortcuts.registerAction(REWIND_SHORTCUT, open);
    return () => {
      unregisterCommand();
      unregisterShortcut();
    };
  }, [available, open, shortcuts]);

  return {
    title: "Conversation history",
    requires: REWIND_CAPABILITIES,
    open: panel.open,
    reveal: panel.reveal,
    grow: true,
    render: () => (
      <RewindPanel
        labelsAvailable={capabilities["upstream.session-labels"]?.state === "available"}
        onClose={close}
        reveal={panel.reveal}
        send={send}
        store={store}
        threadId={threadId}
        transitions={transitions}
      />
    ),
  };
}
