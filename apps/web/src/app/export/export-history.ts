import type { ChatHistory } from "@/modules/D4/export";
import type { OmpRuntimeStore } from "@/modules/R0/store/store";
import type { KeyedTranscriptMessage } from "@/modules/U1/copy";
import { orderedMessages } from "../copy/use-copy-from-chat";

/**
 * The open chat as D4's export reads it. The messages, the loaded-entry count and the older-page flag are read from
 * the live store each time, so a page that loads during an export is seen. Loading an older page runs the open chat's
 * loader. With no open chat there is no loader, so loading reads nothing, and D4's whole-chat read stops with its
 * plain failure instead of waiting for entries that never come.
 */
export function chatHistoryOf(
  store: Pick<OmpRuntimeStore, "getSnapshot">,
  loadOlder: (() => Promise<void>) | undefined,
): ChatHistory<KeyedTranscriptMessage> {
  return {
    messages: () => orderedMessages(store.getSnapshot()),
    loadedEntries: () => Object.keys(store.getSnapshot().transcript.entries).length,
    hasOlder: () => store.getSnapshot().transcript.hasOlder,
    loadOlder: () => loadOlder?.() ?? Promise.resolve(),
  };
}
