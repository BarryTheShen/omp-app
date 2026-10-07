import type { ThreadId } from "@omp-app/contracts";
import { useEffect, useState } from "react";
import type { SessionCatalogModel } from "@/modules/R1/catalog/catalog";

type TitleSource = Pick<SessionCatalogModel, "getSnapshot" | "subscribe" | "fetch">;

/**
 * The open chat's title. It comes from the list the sidebar has loaded and follows it as it
 * refreshes; a chat the list does not hold (opened through a search, or again after a reload, when
 * only the first page is loaded) is read on its own, so opening a chat never fetches the list.
 */
export function useSessionTitle(catalog: TitleSource | null, threadId: ThreadId | undefined) {
  const [title, setTitle] = useState("New conversation");
  useEffect(() => {
    if (catalog === null || threadId === undefined) {
      setTitle("New conversation");
      return;
    }
    let active = true;
    const fromList = (): boolean => {
      const session = catalog.getSnapshot().sessions.find((item) => item.id === threadId);
      if (session === undefined) return false;
      setTitle(session.title ?? "Conversation");
      return true;
    };
    if (!fromList()) {
      setTitle("Conversation");
      void catalog
        .fetch(threadId)
        .then((metadata) => {
          if (active && !fromList()) setTitle(metadata.title ?? "Conversation");
        })
        .catch(() => undefined);
    }
    const unsubscribe = catalog.subscribe(() => {
      if (active) fromList();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [catalog, threadId]);
  return title;
}
