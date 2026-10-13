import type { ThreadId } from "@omp-app/contracts";
import { useSyncExternalStore } from "react";
import type { NotificationProjector, TranscriptNoticesSnapshot } from "../notifications";
import { NOTICE_TONE } from "./notices";

/**
 * The notices the projector wrote into this chat's transcript (a todo reminder, a failed retry). The thread draws each
 * one after the row it follows (see `transcriptNoticeSource`); with `keys`, only those notices are drawn. The first
 * line of a notice is its heading; the lines under it follow. The announcer reads each one once, as its live setting
 * says, so this list is not a live region of its own.
 */
export function TranscriptNoticeList({
  projector,
  threadId,
  keys,
}: {
  readonly projector: NotificationProjector;
  readonly threadId: ThreadId;
  readonly keys?: readonly string[];
}) {
  const transcript = projector.getTranscript();
  const snapshot = useSyncExternalStore(
    transcript.subscribe,
    transcript.getSnapshot,
    transcript.getSnapshot,
  );
  const shown = snapshot.notices.filter(
    (notice) =>
      notice.threadId === threadId && (keys === undefined || keys.includes(notice.dedupeKey)),
  );
  if (shown.length === 0) return null;
  return (
    <section
      aria-label="Notices in this conversation"
      className="mx-auto flex w-full min-w-0 max-w-(--layout-thread-width) flex-col gap-2 px-6 py-3"
      data-slot="n1-transcript-notices"
    >
      {shown.map((notice) => {
        const [heading, ...lines] = notice.message.split("\n");
        return (
          <article
            className={`min-w-0 rounded-md border px-3 py-2 text-sm ${NOTICE_TONE[notice.severity]}`}
            data-dedupe-key={notice.dedupeKey}
            data-severity={notice.severity}
            key={notice.dedupeKey}
          >
            <p className="font-medium break-words">{heading}</p>
            {lines.length > 0 && (
              <p className="mt-1 break-words whitespace-pre-line">{lines.join("\n")}</p>
            )}
          </article>
        );
      })}
    </section>
  );
}

/**
 * The chat's transcript notices as the thread reads them: each with the row it follows (`afterRow`). The thread places
 * them (see `placeNotices`) and draws each group through `renderGroup`. The thread re-reads the list only when the
 * projector's transcript changes, and the list is the same array until then.
 */
export function transcriptNoticeSource(projector: NotificationProjector, threadId: ThreadId) {
  const transcript = projector.getTranscript();
  let read: TranscriptNoticesSnapshot | undefined;
  let rows: readonly { readonly key: string; readonly afterRow: string | null | undefined }[] = [];
  return {
    subscribe: transcript.subscribe,
    getSnapshot: () => {
      const snapshot = transcript.getSnapshot();
      if (snapshot !== read) {
        read = snapshot;
        rows = snapshot.notices
          .filter((notice) => notice.threadId === threadId)
          .map((notice) => ({ key: notice.dedupeKey, afterRow: notice.afterMessage }));
      }
      return rows;
    },
    renderGroup: (keys: readonly string[]) => (
      <TranscriptNoticeList keys={keys} projector={projector} threadId={threadId} />
    ),
  };
}
