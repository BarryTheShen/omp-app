import { z } from "zod";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";
import { FolderPath, SessionFilePath, ThreadId } from "../../core/ids";

/**
 * What a running chat does now (D1): it works on a turn, waits for an answer from you (an approval or a question), is
 * paused (omp's `/pause`), or is idle, its process kept for when you come back to it.
 */
export const RunningChatState = z.enum(["working", "waiting", "paused", "idle"]);
export type RunningChatState = z.infer<typeof RunningChatState>;

/** A chat whose process runs on the server now, from any folder (D1). */
export const RunningChat = z
  .object({
    threadId: ThreadId,
    folder: FolderPath,
    /** Its name as the chat list shows it; null before omp has written its file (its first reply still runs). */
    title: z.string().nullable(),
    /** The session file it runs, to open it from any folder; null while the app does not know it yet. */
    sessionFile: SessionFilePath.nullable(),
    state: RunningChatState,
  })
  .strict();
export type RunningChat = z.infer<typeof RunningChat>;

export const RunningChatsList = z.object({ chats: z.array(RunningChat) }).strict();
export type RunningChatsList = z.infer<typeof RunningChatsList>;

/** The sentence a stop gives for a chat another tab or window has open: the person closes it there, then stops it. */
export const RUNNING_STOP_OTHER_VIEW =
  "Another tab or window has this chat open. Close it there, then stop it again.";

/** The chats that run on the server, from every folder (D1): the list, and an event each time it changes. */
export const RunningChatsPort = definePort({
  name: "A0.runningChats",
  methods: {
    /** Those waiting for you first, then those working, then the paused, then the idle; each group by name. */
    list: { args: z.object({}).strict(), result: RunningChatsList },
    /**
     * Ends a chat's process. A turn that runs is asked to end first, as Esc ends it, and ends with the process at most ten
     * seconds later; a paused one ends with it at once. The chat stays in its folder's list, and opening it starts it
     * again. Refused while another tab or window has it open; the asking tab's own views go with it.
     */
    stop: { args: z.object({ threadId: ThreadId }).strict(), result: z.null() },
  },
  events: {
    /** A chat's process started or ended, or what one does changed. */
    changed: { payload: z.object({ at: z.number() }).strict() },
  },
});
export type RunningChatsPort = typeof RunningChatsPort;
export type RunningChatsClient = PortClient<RunningChatsPort>;
export type RunningChatsHandlers<Context> = PortHandlers<RunningChatsPort, Context>;
