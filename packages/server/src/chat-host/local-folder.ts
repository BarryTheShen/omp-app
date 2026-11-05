import { mkdir } from "node:fs/promises";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { LocalFolder } from "@omp-app/contracts/chat-host";

/**
 * The chat's own scratch folder, omp's `local://` (#2830): a file attached to a message is put there, and omp's tools read
 * and move it as `local://<name>`. omp places it under the session's artifacts folder, or in the temp folder when the
 * session has none (18.12.6 `internal-urls/local-protocol.ts:240-251`), from the same two readings its SDK passes
 * (`sdk.ts:2575-2578`). A new chat knows its session file's path before the file is written, so the folder is made here
 * when missing, private to the user as omp's own sessions are.
 */
export async function localFolder(session: AgentSession): Promise<LocalFolder> {
  const { sessionManager } = session;
  const folder = resolveLocalRoot({
    getArtifactsDir: () => sessionManager.getArtifactsDir(),
    getSessionId: () => sessionManager.getSessionId(),
  });
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return { folder };
}
