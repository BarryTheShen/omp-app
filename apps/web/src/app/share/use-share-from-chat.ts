import type { AppClient } from "@omp-app/client";
import type { FolderPath, ThreadId } from "@omp-app/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClipboardPort } from "@/modules/D4/contract";
import {
  createShareCommandClient,
  createShareController,
  createSharePort,
  createShareSettingsReader,
  D4_SHARE_COMMAND,
  describeShareOutcome,
  type ShareController,
} from "@/modules/D4/share";
import type { DialogHost } from "@/modules/U4/contract";
import { useShortcutRegistry } from "@/shortcuts";

/** The composer's text box: focus goes back to it once the share has settled. */
const COMPOSER_INPUT = 'textarea[aria-label="Message input"]';

export interface ShareFromChatOptions {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  readonly folder: FolderPath | null;
  /** The open chat's dialog host: the questions open over this chat. */
  readonly dialogs: DialogHost;
  readonly clipboard: ClipboardPort;
  /** Shows a sentence in the chat's status line: the upload in progress, or the outcome. */
  readonly showStatus: (text: string | null) => void;
  /** Shows a failure in the chat's error line. */
  readonly showError: (text: string | null) => void;
}

/**
 * Builds the share controller for the open chat and registers "Share this chat" as a palette command. The palette
 * does not wait for the question: its dialog opens as the palette closes. The controller is returned for typed
 * `/share`, which runs the same flow. Focus returns to the composer once the share settles.
 */
export function useShareFromChat({
  client,
  threadId,
  folder,
  dialogs,
  clipboard,
  showStatus,
  showError,
}: ShareFromChatOptions): ShareController {
  const shortcuts = useShortcutRegistry();
  // Read at each share, so the question names the folder the chat is in at that moment, and a folder change keeps
  // the controller.
  const folderRef = useRef(folder);
  const statusRef = useRef(showStatus);
  useLayoutEffect(() => {
    folderRef.current = folder;
    statusRef.current = showStatus;
  });
  const controller = useMemo(
    () =>
      createShareController({
        threadId,
        sharePort: createSharePort(createShareCommandClient(client)),
        dialogs,
        clipboard,
        settings: createShareSettingsReader({ client, folder: () => folderRef.current }),
        onUploading: () => statusRef.current("Sharing this chat…"),
      }),
    [client, clipboard, dialogs, threadId],
  );
  const [settled, setSettled] = useState(0);
  const run = useCallback(() => {
    void controller.share().then((outcome) => {
      if (outcome.outcome === "failed") {
        showStatus(null);
        showError(outcome.error.message);
      } else {
        showError(null);
        showStatus(describeShareOutcome(outcome));
      }
      setSettled((count) => count + 1);
    });
  }, [controller, showError, showStatus]);
  useEffect(() => {
    if (settled > 0) document.querySelector<HTMLTextAreaElement>(COMPOSER_INPUT)?.focus();
  }, [settled]);
  useEffect(() => shortcuts.registerCommand(D4_SHARE_COMMAND.id, { run }), [run, shortcuts]);
  return controller;
}
