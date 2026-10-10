import type { ThreadId } from "@omp-app/contracts";
import { useEffect } from "react";
import type { P3FailedState, P3RunState } from "@/modules/P3/runs/status";
import { P3_RETRY_SHORTCUT } from "@/modules/P3/shortcuts/descriptors";
import { useShortcutRegistry } from "@/shortcuts";
import type { ShortcutRegistry } from "@/shortcuts/registry";

export interface RetryShortcutOptions {
  readonly registry: ShortcutRegistry;
  /** The chat this composer belongs to. */
  readonly threadId: ThreadId;
  readonly status: { getSnapshot(): P3RunState };
  readonly retry: (failure: P3FailedState) => Promise<void>;
}

/**
 * Alt+R retries the failed turn exactly when the edit status shows "Try again": a failed run that can
 * be retried and belongs to this chat (P3RunStatusSurface). Anything else does nothing.
 */
export function registerRetryShortcut({
  registry,
  threadId,
  status,
  retry,
}: RetryShortcutOptions): () => void {
  return registry.registerAction(P3_RETRY_SHORTCUT.id, () => {
    const state = status.getSnapshot();
    if (state.phase !== "failed" || !state.retryable || state.chatThreadId !== threadId) return;
    return retry(state);
  });
}

/** Keeps the Alt+R action registered while the open chat is mounted. */
export function useRetryShortcut(options: Omit<RetryShortcutOptions, "registry">): void {
  const registry = useShortcutRegistry();
  const { threadId, status, retry } = options;
  useEffect(
    () => registerRetryShortcut({ registry, threadId, status, retry }),
    [registry, retry, status, threadId],
  );
}
