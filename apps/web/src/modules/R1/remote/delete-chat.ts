import type { SessionDeleteArgs, ThreadId } from "@omp-app/contracts";
import type { SessionMetadata } from "../contract";
import { type CloseThread, releaseThread } from "../release";
import type { RemoteThreadCatalogSource } from "./remote";

/** The session-file port's delete, as the sidebar's remote calls it. */
export interface SessionFileDelete {
  deleteSession(args: SessionDeleteArgs): Promise<unknown>;
}

/**
 * Deletes one chat on the server. This app lets go of its own hold on the chat first, so omp can stop. Then the server
 * removes the chat's file, and it refuses a chat omp still holds, or whose turn runs, with its own sentence; that
 * refusal reaches the caller unchanged. The sidebar drops the row when the server's removed event arrives, because the
 * catalog already removes a chat on that event.
 */
export async function deleteChatFile(args: {
  readonly threadId: ThreadId;
  readonly catalog: RemoteThreadCatalogSource;
  readonly sessionFiles: SessionFileDelete;
  readonly close: CloseThread;
}): Promise<void> {
  const session: SessionMetadata = await args.catalog.fetch(args.threadId);
  await releaseThread(args.close, args.threadId);
  // The chat's own folder is the one whose listing returns its file, so the server checks it there.
  await args.sessionFiles.deleteSession({ folder: session.cwd, sessionFile: session.sessionFile });
}
