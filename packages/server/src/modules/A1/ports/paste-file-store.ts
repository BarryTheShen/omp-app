import { AppFailure, PasteFileStore, SessionFilePath, type ThreadId } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

/**
 * The session file a paste or an attached file is saved beside. An open chat's file comes first: a new chat's omp names
 * its file before it writes it, so the file may not be on disk yet. A saved chat is found on disk.
 */
export async function resolveChatSessionFile(
  context: Pick<A1PortContext, "openSessionFile" | "sessionFileStore">,
  threadId: ThreadId,
  what = "the pasted text",
): Promise<SessionFilePath> {
  const open = context.openSessionFile(threadId);
  if (open !== undefined) return open;
  const saved = await context.sessionFileStore.findSession(threadId);
  const parsed = saved === undefined ? undefined : SessionFilePath.safeParse(saved.sessionFile);
  if (parsed?.success) return parsed.data;
  throw new AppFailure({
    code: "not_found",
    message: `The chat could not be found, so ${what} was not saved.`,
    retryable: false,
  });
}

export function createPasteFileStoreRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    PasteFileStore,
    {
      save: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        const sessionFile = await resolveChatSessionFile(context, args.threadId);
        return context.pasteFileStore.save({ sessionFile, text: args.text });
      },
      saveFile: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        const sessionFile = await resolveChatSessionFile(
          context,
          args.threadId,
          "the attached file",
        );
        return context.pasteFileStore.saveFile({ sessionFile, name: args.name, text: args.text });
      },
    },
    context.publish,
    [],
    context.watchStreamActivity,
  );
}
