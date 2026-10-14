import type { AppClient } from "@omp-app/client";
import type { FolderPath, ThreadId } from "@omp-app/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DialogHost } from "@/modules/U4/contract";
import { useCapabilityStatus } from "@/registry-core/hooks";
import { useShortcutRegistry } from "@/shortcuts";
import { createImportController } from "./controller";
import { D4_IMPORT_SHARE_COMMAND } from "./descriptors";
import { describeImportOutcome } from "./outcome";
import { createShareImportClient, createShareImportPort } from "./port";

/** The composer's text box: focus goes back to it once the import has settled. */
const COMPOSER_INPUT = 'textarea[aria-label="Message input"]';

export interface ImportFromShareOptions {
  readonly client: AppClient;
  /** The open chat: its folder is where the new chat goes, and its dialog host shows the questions. */
  readonly threadId: ThreadId;
  readonly folder: FolderPath | null;
  readonly dialogs: DialogHost;
  /** Opens the new chat, through the same path as the sidebar. */
  readonly openChat: (threadId: ThreadId) => Promise<void>;
  /** Shows a sentence in the chat's status line: the import in progress, or the outcome. */
  readonly showStatus: (text: string | null) => void;
  /** Shows a refusal or failure in the chat's error line. */
  readonly showError: (text: string | null) => void;
}

/**
 * Registers "Import a shared chat" as a palette command. While omp cannot import, the palette lists the command as
 * unavailable and no question opens; once omp can, the link question opens as the palette closes. Focus returns to
 * the composer once the import settles.
 */
export function useImportFromShare({
  client,
  threadId,
  folder,
  dialogs,
  openChat,
  showStatus,
  showError,
}: ImportFromShareOptions): void {
  const shortcuts = useShortcutRegistry();
  // The upstream gate: the same status the palette reads, so the command and the questions agree.
  const importStatus = useCapabilityStatus("upstream.session-import");
  const importAvailable = importStatus?.state === "available" || importStatus?.state === "fallback";
  // Read at each import, so the new chat goes in the folder the chat is in at that moment and a folder change keeps
  // the controller.
  const folderRef = useRef(folder);
  const openChatRef = useRef(openChat);
  const statusRef = useRef(showStatus);
  const availableRef = useRef(importAvailable);
  useLayoutEffect(() => {
    folderRef.current = folder;
    openChatRef.current = openChat;
    statusRef.current = showStatus;
    availableRef.current = importAvailable;
  });
  const controller = useMemo(
    () =>
      createImportController({
        threadId,
        folder: () => folderRef.current,
        importPort: createShareImportPort(createShareImportClient(client)),
        importAvailable: () => availableRef.current,
        dialogs,
        openChat: (id) => openChatRef.current(id),
        onImporting: () => statusRef.current("Importing the shared chat…"),
      }),
    [client, dialogs, threadId],
  );
  const [settled, setSettled] = useState(0);
  const run = useCallback(() => {
    void controller.importShare().then((outcome) => {
      if (outcome.outcome === "failed" || outcome.outcome === "refused") {
        showStatus(null);
        showError(describeImportOutcome(outcome));
      } else {
        showError(null);
        showStatus(describeImportOutcome(outcome));
      }
      setSettled((count) => count + 1);
    });
  }, [controller, showError, showStatus]);
  useEffect(() => {
    if (settled > 0) document.querySelector<HTMLTextAreaElement>(COMPOSER_INPUT)?.focus();
  }, [settled]);
  useEffect(() => shortcuts.registerCommand(D4_IMPORT_SHARE_COMMAND.id, { run }), [run, shortcuts]);
}
