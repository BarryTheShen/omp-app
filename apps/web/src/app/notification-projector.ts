import type { ThreadId } from "@omp-app/contracts";
import { useEffect, useLayoutEffect, useRef } from "react";
import { NotificationProjector, sessionRetiredNotices } from "@/modules/N1/notifications";
import type { OmpRuntimeStore } from "@/modules/R0/store";

export function useNotificationProjector(
  store: OmpRuntimeStore,
  onEditorText: (text: string, context: { readonly threadId: ThreadId }) => void,
  instanceId: () => string | undefined,
): NotificationProjector {
  const projectorRef = useRef<NotificationProjector | null>(null);
  const generationRef = useRef(0);
  if (projectorRef.current === null) {
    projectorRef.current = new NotificationProjector({
      source: store,
      events: store,
      onEditorText,
      retired: sessionRetiredNotices(window.sessionStorage, instanceId),
    });
  }
  // The page keeps one projector for its life, and each chat has its own store: the projector follows the store of the
  // chat on screen (`NotificationProjector.follow`), so the chat's events and state are the ones it projects.
  useLayoutEffect(() => {
    projectorRef.current?.follow(store);
  }, [store]);
  useEffect(() => {
    const projector = projectorRef.current;
    const generation = ++generationRef.current;
    return () => {
      queueMicrotask(() => {
        if (generationRef.current !== generation || projectorRef.current !== projector) return;
        projector?.dispose();
        projectorRef.current = null;
      });
    };
  }, []);
  return projectorRef.current;
}
