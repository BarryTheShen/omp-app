import type { ChatHostImage } from "@omp-app/contracts/chat-host";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { FoldContext, type Folds, NO_FOLDS } from "../vendor/collab-web/lib/fold";
import { Composer, type ComposerHandle } from "./Composer";
import type { ChatController } from "./controller";
import { HostRequests } from "./HostRequests";
import { userText } from "./MessageActions";
import { type RowActions, TranscriptList } from "./TranscriptList";

/** What Edit brings back to the message box: the message's text and images; `key` tells one edit from the next. */
export interface ComposerRestore {
  readonly key: number;
  readonly text: string;
  readonly images: readonly ChatHostImage[];
}

/**
 * One chat: its transcript, what omp waits on, and the message box. Ctrl+O opens or folds every tool card and Ctrl+T
 * shows or hides every thinking block, anywhere in the pane.
 */
export function ChatPane({
  controller,
  onComposer,
}: {
  readonly controller: ChatController;
  /** The message box's handle, for the palette; null once it is gone. */
  readonly onComposer?: (handle: ComposerHandle | null) => void;
}): ReactNode {
  const snapshot = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const loadOlder = useCallback(() => void controller.loadOlder(), [controller]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [restore, setRestore] = useState<ComposerRestore | null>(null);
  const [folds, setFolds] = useState<Folds>(NO_FOLDS);
  // What you sent, oldest first: the message box's Up and Down go through it, as omp's history does.
  const history = useMemo(
    () =>
      snapshot.entries
        .map(userText)
        .filter((text): text is string => text !== null && text.trim() !== ""),
    [snapshot.entries],
  );
  const waiting = snapshot.requests[0];
  const approval = waiting?.method === "ui.approve" ? waiting.id : null;
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
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    const which = event.code === "KeyO" ? "tools" : event.code === "KeyT" ? "thinking" : null;
    if (which === null) return;
    event.preventDefault();
    setFolds((current) => ({
      ...current,
      [which]: { open: !current[which].open, epoch: current[which].epoch + 1 },
    }));
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the pane's keys, from its message box or its transcript
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <FoldContext value={folds}>
        <TranscriptList
          snapshot={snapshot}
          onNearTop={loadOlder}
          actions={actions}
          welcome={welcome}
        />
      </FoldContext>
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
        history={history}
        approval={approval}
        onHandle={onComposer}
      />
    </div>
  );
}
