import type { AppClient } from "@omp-app/client";
import {
  type OpenQuestionsChat,
  QuestionsPort,
  type WorkThreadEntry,
  type WorkThreadId,
  type WorkThreadList,
  type WorkThreadSummary,
  WorkThreadsPort,
} from "@omp-app/contracts";
import { isOmpQuestion } from "@omp-app/contracts/chat-host";
import { useEffect, useState } from "react";
import { follow } from "../../follow";

/**
 * Every chat that omp stopped to ask you something (its own questions, a plan to approve), with those questions, kept
 * current from the server's `changed`; empty from a server that keeps no such list.
 */
export function useStoppedChats(client: AppClient): readonly OpenQuestionsChat[] {
  const [chats, setChats] = useState<readonly OpenQuestionsChat[]>([]);
  useEffect(() => {
    let active = true;
    const read = (): void => {
      client
        .port(QuestionsPort)
        .list({})
        .then(
          (listed) =>
            active && setChats(listed.chats.filter((chat) => chat.requests.some(isOmpQuestion))),
          () => undefined,
        );
    };
    read();
    const stopChanged = follow(client.subscribe(QuestionsPort, "changed"), read);
    const stopOutage = client.onOutage(read);
    return () => {
      active = false;
      stopChanged();
      stopOutage();
    };
  }, [client]);
  return chats;
}

/** Whether a thread waits on the person: a question with no answer, or the agent set it waiting. */
export const waitsOnYou = (thread: WorkThreadSummary): boolean =>
  thread.unanswered > 0 || thread.state === "waiting";

/** The list's filters, in their order. */
export const FILTERS = ["Needs you", "In progress", "Done", "All"] as const;
export type Filter = (typeof FILTERS)[number];

/** The threads a filter shows, in the list's order (newest activity first). */
export function filtered(
  threads: readonly WorkThreadSummary[],
  filter: Filter,
): WorkThreadSummary[] {
  switch (filter) {
    case "Needs you":
      return threads.filter(waitsOnYou);
    case "In progress":
      return threads.filter((thread) => thread.state === "open" || thread.state === "in_progress");
    case "Done":
      return threads.filter((thread) => thread.state === "done" || thread.state === "closed");
    case "All":
      return [...threads];
  }
}

/**
 * Workbench's list, kept current from the server's `changed`, and read again after an outage; null until first read.
 * An older server has no Workbench: the list stays null and `missing` is true.
 */
export function useWorkThreadList(client: AppClient): {
  readonly list: WorkThreadList | null;
  readonly missing: boolean;
} {
  const [list, setList] = useState<WorkThreadList | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let active = true;
    const read = (): void => {
      client
        .port(WorkThreadsPort)
        .list({})
        .then(
          (listed) => {
            if (!active) return;
            setList(listed);
            setMissing(false);
          },
          () => active && setMissing(true),
        );
    };
    read();
    const stopChanged = follow(client.subscribe(WorkThreadsPort, "changed"), read);
    const stopOutage = client.onOutage(read);
    return () => {
      active = false;
      stopChanged();
      stopOutage();
    };
  }, [client]);
  return { list, missing };
}

/** One thread's timeline, read again whenever that thread changes; null until read, or when it is gone. */
export function useWorkThread(
  client: AppClient,
  id: WorkThreadId,
): { readonly summary: WorkThreadSummary; readonly entries: readonly WorkThreadEntry[] } | null {
  const [read, setRead] = useState<{
    readonly summary: WorkThreadSummary;
    readonly entries: readonly WorkThreadEntry[];
  } | null>(null);
  useEffect(() => {
    let active = true;
    setRead(null);
    const load = (): void => {
      client
        .port(WorkThreadsPort)
        .read({ id })
        .then(
          (thread) => active && setRead(thread),
          () => active && setRead(null),
        );
    };
    load();
    const stopChanged = follow(client.subscribe(WorkThreadsPort, "changed"), (change) => {
      if (change.id === id) load();
    });
    const stopOutage = client.onOutage(load);
    return () => {
      active = false;
      stopChanged();
      stopOutage();
    };
  }, [client, id]);
  return read;
}
