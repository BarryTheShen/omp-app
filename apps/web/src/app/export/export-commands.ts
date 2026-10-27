import type {
  ChatSessionClient,
  OmpCommandGateway,
  PortClient,
  ThreadId,
} from "@omp-app/contracts";
import type { SlashAppCommand } from "@/modules/D2/slash";
import { createExportPort, createExportSlashCommands } from "@/modules/D4/export";
import type { OmpRuntimeStore } from "@/modules/R0/store/store";
import type { DialogHost } from "@/modules/U4/contract";
import { chatHistoryOf } from "./export-history";

/** What the open chat hands its export commands: the chat, its live store and older-page loader, and its ports. */
export interface ExportCommandsOptions {
  readonly threadId: ThreadId;
  readonly store: Pick<OmpRuntimeStore, "getSnapshot">;
  /** Loads the page of messages older than the ones shown; undefined when no chat is open. */
  readonly loadOlder: (() => Promise<void>) | undefined;
  readonly session: Pick<ChatSessionClient, "request">;
  readonly gateway: Pick<PortClient<typeof OmpCommandGateway>, "dump">;
  readonly dialogs: DialogHost;
  readonly download: (fileName: string, text: string) => void;
}

/**
 * D4's export slash commands for the open chat, for the composition to add to the composer's app commands: `/export`
 * (the picker), `/dump`, `/dump all` and `/dump anon` (omp's reports saved as files), and `/open` and `/record`
 * (terminal-only). The port reads the chat through the store, so a long chat's export loads its older pages first.
 */
export function exportSlashCommandsFor(options: ExportCommandsOptions): readonly SlashAppCommand[] {
  const port = createExportPort({
    threadId: options.threadId,
    history: chatHistoryOf(options.store, options.loadOlder),
    session: options.session,
    gateway: options.gateway,
  });
  return createExportSlashCommands({
    threadId: options.threadId,
    port,
    dialogs: options.dialogs,
    download: options.download,
  });
}
