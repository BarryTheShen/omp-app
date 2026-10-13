import type { SessionDeleteArgs, ThreadId } from "@omp-app/contracts";
import type { SessionMetadata } from "../contract";
import type { RemoteThreadCatalogSource } from "./remote";

/** The session-file port's delete, as the sidebar's remote calls it. */
export interface SessionFileDelete {
  deleteSession(args: SessionDeleteArgs): Promise<unknown>;
}

/**
 * Deletes one chat on the server, which decides. It refuses a chat whose turn runs, or that another view holds, with its
 * own sentence, and the chat stays as it was. A view that asks for the delete is counted too: the server checks the turn
 * and the other views first, and lets this view go only then, before it stops omp. The sidebar drops the row when the
 * server's removed event arrives, because the catalog already removes a chat on that event.
 */
export async function deleteChatFile(args: {
  readonly threadId: ThreadId;
  readonly catalog: RemoteThreadCatalogSource;
  readonly sessionFiles: SessionFileDelete;
}): Promise<void> {
  const session: SessionMetadata = await args.catalog.fetch(args.threadId);
  // The chat's own folder is the one whose listing returns its file, so the server checks it there.
  await args.sessionFiles.deleteSession({ folder: session.cwd, sessionFile: session.sessionFile });
}
