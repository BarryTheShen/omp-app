import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import { Composer } from "./Composer";
import type { ChatController } from "./controller";
import { HostRequests } from "./HostRequests";
import { TranscriptList } from "./TranscriptList";

export function ChatPane({ controller }: { readonly controller: ChatController }): ReactNode {
  const snapshot = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const loadOlder = useCallback(() => void controller.loadOlder(), [controller]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TranscriptList snapshot={snapshot} onNearTop={loadOlder} />
      <HostRequests controller={controller} requests={snapshot.requests} />
      <Composer
        controller={controller}
        working={snapshot.working}
        disabled={snapshot.phase !== "live"}
        model={snapshot.model}
        thinkingLevel={snapshot.thinkingLevel}
        queue={snapshot.queue}
        activity={snapshot.activity}
      />
    </div>
  );
}
