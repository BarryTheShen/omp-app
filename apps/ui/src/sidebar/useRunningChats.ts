import type { AppClient } from "@omp-app/client";
import { type RunningChat, RunningChatsList, RunningChatsPort } from "@omp-app/contracts";
import { useEffect, useState } from "react";
import { follow } from "../follow";
import { lastSeen } from "../lastSeen";

/** The running list as this browser saw it last: shown at once, after a reload too, while it is read again. */
const kept = lastSeen<RunningChatsList>("running-chats", (stored) => {
  const parsed = RunningChatsList.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
});

/**
 * The chats that run on the server, from every folder (D1), kept current: read again each time the server says the
 * list changed. A server from before the list has none to give, and the list stays empty.
 */
export function useRunningChats(client: AppClient): readonly RunningChat[] {
  const [chats, setChats] = useState<readonly RunningChat[]>(() => kept.get()?.chats ?? []);
  useEffect(() => {
    let active = true;
    const read = (): void => {
      client
        .port(RunningChatsPort)
        .list({})
        .then(
          (listed) => {
            if (!active) return;
            kept.set(listed);
            setChats(listed.chats);
          },
          () => undefined,
        );
    };
    read();
    const stop = follow(client.subscribe(RunningChatsPort, "changed"), read);
    return () => {
      active = false;
      stop();
    };
  }, [client]);
  return chats;
}
