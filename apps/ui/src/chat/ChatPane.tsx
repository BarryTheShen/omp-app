import type { ChatHostImage } from "@omp-app/contracts/chat-host";
import { type ReactNode, useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Composer } from "./Composer";
import type { ChatController } from "./controller";
import { HostRequests } from "./HostRequests";
import { type RowActions, TranscriptList } from "./TranscriptList";

/** What Edit brings back to the message box: the message's text and images; `key` tells one edit from the next. */
export interface ComposerRestore {
  readonly key: number;
  readonly text: string;
  readonly images: readonly ChatHostImage[];
}

export function ChatPane({ controller }: { readonly controller: ChatController }): ReactNode {
  const snapshot = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const loadOlder = useCallback(() => void controller.loadOlder(), [controller]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [restore, setRestore] = useState<ComposerRestore | null>(null);
  const canEdit = !snapshot.working && snapshot.phase === "live";
  const actions = useMemo<RowActions>(
    () => ({
      // omp's own `/retry`: the last failed turn, again.
      onRetry: () => controller.send("/retry"),
      onSwitchModel: () => setModelPickerOpen(true),
      onStopShell: () => controller.stopShell(),
      onDismissNotice: (id) => controller.store.dismissNotice(id),
      onEdit: (entryId) => {
        controller
          .rewind(entryId)
          .then((back) => {
            if (back !== null) setRestore({ key: Date.now(), ...back });
          })
          .catch((failure: unknown) =>
            controller.store.addNotice(
              `Could not edit that message: ${failure instanceof Error ? failure.message : String(failure)}`,
              "error",
            ),
          );
      },
      canEdit,
    }),
    [controller, canEdit],
  );
  const welcome = useMemo(
    () => (controller.isNew ? { folder: controller.folder } : null),
    [controller],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TranscriptList
        snapshot={snapshot}
        onNearTop={loadOlder}
        actions={actions}
        welcome={welcome}
      />
      <HostRequests controller={controller} requests={snapshot.requests} />
      <Composer
        controller={controller}
        working={snapshot.working}
        disabled={snapshot.phase !== "live"}
        model={snapshot.model}
        thinkingLevel={snapshot.thinkingLevel}
        queue={snapshot.queue}
        activity={snapshot.activity}
        modelPickerOpen={modelPickerOpen}
        onModelPickerOpenChange={setModelPickerOpen}
        restore={restore}
      />
    </div>
  );
}
