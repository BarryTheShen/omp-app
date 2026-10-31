import type { AppClient } from "@omp-app/client";
import { AppFailure, ChatSessionPort } from "@omp-app/contracts";

/**
 * Pauses or resumes every chat the server runs (omp's `/pause` in each), and says what came of it. A chat whose omp
 * started before pause existed is left as it is; a server older than pause-all is said in words a person acts on.
 */
export async function pauseAllChats(client: AppClient, paused: boolean): Promise<string> {
  let chats: number;
  try {
    ({ chats } = await client.port(ChatSessionPort).pauseAll({ paused }));
  } catch (failure) {
    if (
      failure instanceof AppFailure &&
      (failure.appError.code === "invalid_args" || failure.appError.code === "not_found")
    ) {
      throw new Error("This app server cannot pause every chat yet; it needs an update.");
    }
    throw failure;
  }
  if (chats === 0) return "No chat is running.";
  return `${paused ? "Paused" : "Resumed"} ${chats} ${chats === 1 ? "chat" : "chats"}.`;
}
