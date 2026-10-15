import { AppFailure, type ThreadId } from "@omp-app/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClipboardPort } from "@/modules/D4/contract";
import {
  createCopyPicker,
  createCopySourceReader,
  createTranscriptActions,
  describeCopyOutcome,
} from "@/modules/D4/copy";
import { D4_COPY_COMMAND, D4_COPY_SHORTCUT } from "@/modules/D4/copy/descriptors";
import type { OmpRuntimeStore, RuntimeSnapshot } from "@/modules/R0/store/store";
import type { KeyedTranscriptMessage } from "@/modules/U1/copy";
import type { DialogHost } from "@/modules/U4/contract";
import { type ShortcutRegistry, useShortcutRegistry } from "@/shortcuts";

/** The composer's text box: the picker hands focus back to it once the picker has settled. */
const COMPOSER_INPUT = 'textarea[aria-label="Message input"]';

/** The browser's clipboard. A refusal (no permission, or no clipboard on this page) rejects. */
export const browserClipboard: ClipboardPort = {
  async writeText(text) {
    await navigator.clipboard.writeText(text);
  },
};

function orderedMessages(snapshot: RuntimeSnapshot): readonly KeyedTranscriptMessage[] {
  return snapshot.messageOrder.flatMap((key) => {
    const record = snapshot.messages[key];
    return record === undefined ? [] : [{ key: record.key, message: record.message }];
  });
}

export interface CopyFromChatOptions {
  readonly threadId: ThreadId;
  readonly store: OmpRuntimeStore;
  /** The open chat's dialog host: the picker's dialogs open over this chat. */
  readonly dialogs: DialogHost;
  readonly clipboard: ClipboardPort;
  readonly download: (fileName: string, text: string) => void;
  /** Shows the picker's one sentence in the chat's status line. */
  readonly showStatus: (text: string | null) => void;
}

/**
 * Registers "Copy from this chat" as a palette command and as its shortcut, and runs D4's conversation
 * copy picker over the open chat. The palette does not wait for the picker: its dialog opens as the palette
 * closes. The picker's sentence goes to the status line, and focus goes back to the composer once the
 * picker settles. It is set from an effect, because the page behind an open dialog is inert.
 */
export function useCopyFromChat({
  threadId,
  store,
  dialogs,
  clipboard,
  download,
  showStatus,
}: CopyFromChatOptions): void {
  const shortcuts = useShortcutRegistry();
  const picker = useMemo(() => {
    const readSource = createCopySourceReader();
    return createCopyPicker({
      threadId,
      dialogs,
      actions: createTranscriptActions({
        threadId,
        messages: () => readSource(orderedMessages(store.getSnapshot())),
        clipboard,
      }),
      download,
    });
  }, [clipboard, dialogs, download, store, threadId]);
  const [settled, setSettled] = useState(0);
  const run = useCallback(() => {
    void picker.run().then((outcome) => {
      showStatus(describeCopyOutcome(outcome));
      setSettled((count) => count + 1);
    });
  }, [picker, showStatus]);
  useEffect(() => {
    if (settled > 0) document.querySelector<HTMLTextAreaElement>(COMPOSER_INPUT)?.focus();
  }, [settled]);
  useEffect(() => {
    const unregisterCommand = shortcuts.registerCommand(D4_COPY_COMMAND.id, {
      run,
      shortcut: D4_COPY_SHORTCUT.id,
    });
    const unregisterShortcut = shortcuts.registerAction(D4_COPY_SHORTCUT.id, run);
    return () => {
      unregisterCommand();
      unregisterShortcut();
    };
  }, [run, shortcuts]);
}

/**
 * Runs "Copy from this chat" for a typed `/copy`: the command the palette runs. The hook registers that command from an
 * effect, so until the effect has run there is nothing to run, and the person is told so.
 */
export function runCopyFromChat(shortcuts: Pick<ShortcutRegistry, "commandFor">): void {
  const command = shortcuts.commandFor(D4_COPY_COMMAND.id);
  if (command === undefined) {
    throw new AppFailure({
      code: "unavailable",
      message: "Copy from this chat isn't ready yet. Try again.",
      retryable: true,
    });
  }
  command.run();
}
