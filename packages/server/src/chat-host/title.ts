import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/**
 * A chat from before omp named the app's chats (#2798): named once from its conversation when its process starts, as
 * omp's `/rename` without a title names one, and saved as an automatic title, which omp's replan refresh keeps up to
 * date. Nothing under `PI_NO_TITLE` (omp names nothing then), nothing for a named chat, and nothing for a new one:
 * `renameTitle` finds no conversation there, and omp names it from its first message.
 */
export async function nameUntitledChat(session: AgentSession): Promise<void> {
  if (Bun.env.PI_NO_TITLE || session.sessionName) return;
  const title = await session.renameTitle();
  if (typeof title === "string" && !session.sessionName)
    await session.setSessionName(title, "auto");
}
