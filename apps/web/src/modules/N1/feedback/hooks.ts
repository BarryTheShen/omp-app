import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Notification } from "../contract";
import type {
  NotificationBusSnapshot,
  NotificationProjectionSnapshot,
  NotificationProjector,
} from "../notifications";

/** How often the bus drops notices whose lifetime has run out. */
const EXPIRY_CHECK_MS = 1000;

export function useProjectionSnapshot(
  projector: NotificationProjector,
): NotificationProjectionSnapshot {
  const subscribe = useCallback(
    (listener: (snapshot: NotificationProjectionSnapshot) => void) => projector.subscribe(listener),
    [projector],
  );
  const getSnapshot = useCallback(() => projector.getSnapshot(), [projector]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useNotificationSnapshot(projector: NotificationProjector): NotificationBusSnapshot {
  const bus = projector.getBus();
  const subscribe = useCallback(
    (listener: (snapshot: NotificationBusSnapshot) => void) => bus.subscribe(listener),
    [bus],
  );
  const getSnapshot = useCallback(() => bus.getSnapshot(), [bus]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Drops expired notices on a timer; the view that draws toasts keeps it running. */
export function useExpiry(projector: NotificationProjector): void {
  useEffect(() => {
    const timer = window.setInterval(() => projector.getBus().expire(), EXPIRY_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [projector]);
}

/**
 * The notices of the chat on screen. The bus keeps every chat's notices, so a page that has been in several chats holds
 * them all; each chat's notices are shown only while that chat is open (issue 2181).
 */
export function useChatNotifications(projector: NotificationProjector): readonly Notification[] {
  const snapshot = useNotificationSnapshot(projector);
  const chat = useProjectionSnapshot(projector).threadId;
  return useMemo(
    () => snapshot.notifications.filter((notification) => notification.threadId === chat),
    [snapshot, chat],
  );
}
