import type { AppClient } from "@omp-app/client";
import {
  type WorkThreadEntry,
  type WorkThreadId,
  type WorkThreadList,
  type WorkThreadSummary,
  WorkThreadsPort,
} from "@omp-app/contracts";
import { useEffect, useState } from "react";
import { follow } from "../../follow";

/** Whether a thread waits on the person: a question with no answer, or the agent set it waiting. */
export const waitsOnYou = (thread: WorkThreadSummary): boolean =>
  thread.unanswered > 0 || thread.state === "waiting";

/** Whether a thread is open: open, in progress or waiting on you; done and closed ones are closed. */
export const isOpen = (thread: WorkThreadSummary): boolean =>
  thread.state !== "done" && thread.state !== "closed";

/** The list's tabs, as a repository's issues have them. */
export const FILTERS = ["Open", "Closed"] as const;
export type Filter = (typeof FILTERS)[number];

/**
 * The threads a tab shows: open ones with those that wait on you first, then newest activity first; closed ones newest
 * activity first.
 */
export function filtered(
  threads: readonly WorkThreadSummary[],
  filter: Filter,
): WorkThreadSummary[] {
  if (filter === "Closed") return threads.filter((thread) => !isOpen(thread));
  const open = threads.filter(isOpen);
  return [...open.filter(waitsOnYou), ...open.filter((thread) => !waitsOnYou(thread))];
}

/** A tab's name with its count: "Open 5", "Closed 3". */
export const tabName = (filter: Filter, threads: readonly WorkThreadSummary[]): string =>
  `${filter} ${filtered(threads, filter).length}`;

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
