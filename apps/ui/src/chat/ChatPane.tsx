import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import { Composer } from "./Composer";
import type { ChatController } from "./controller";
import { TranscriptList } from "./TranscriptList";

export function ChatPane({ controller }: { readonly controller: ChatController }): ReactNode {
  const snapshot = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const loadOlder = useCallback(() => void controller.loadOlder(), [controller]);
  const send = useCallback(
    (text: string, mode: "auto" | "followUp") => controller.send(text, mode),
    [controller],
  );
  const stop = useCallback(() => controller.stop(), [controller]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TranscriptList snapshot={snapshot} onNearTop={loadOlder} />
      <Composer
        working={snapshot.working}
        disabled={snapshot.phase !== "live"}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}
