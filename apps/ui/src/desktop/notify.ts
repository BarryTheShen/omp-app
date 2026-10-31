import type { AppClient } from "@omp-app/client";
import type { ConfigEntry, FolderPath, ThreadId } from "@omp-app/contracts";
import { useEffect, useMemo, useRef } from "react";
import type { InboxEntry } from "../inbox/inbox";
import { useConfig } from "../settings/useConfig";
import { notifyDesktop } from "./bridge";

/**
 * In the desktop window: a chat that starts waiting for you (an approval, a question) while the window is in the
 * background raises a desktop notification with its pane's title. `waiting` maps each open chat that waits to its
 * pane's title. In a browser nothing is shown.
 */
export function useWaitingNotifications(waiting: ReadonlyMap<ThreadId, string>): void {
  const seen = useRef(waiting);
  useEffect(() => {
    const before = seen.current;
    seen.current = waiting;
    if (document.hasFocus()) return;
    for (const [id, title] of waiting) {
      if (!before.has(id)) notifyDesktop(title === "" ? "A chat" : title, "Waiting for you");
    }
  }, [waiting]);
}

/** omp's two notification settings, as in force: `completion.notify` (on by default) and `error.notify` (off). */
export interface NotifySettings {
  readonly completion: boolean;
  readonly error: boolean;
}

/** A notification to raise: the chat's title, and omp's words for what its turn came to. */
export interface Notice {
  readonly summary: string;
  readonly body: string;
}

const entryKey = (entry: InboxEntry): string => `${entry.threadId} ${entry.at}`;

/**
 * The notices for the inbox's new entries, as omp's terminal raises them (`sendCompletionNotification`,
 * `sendErrorNotification`): a turn done, "Complete", while `completion.notify` is on; a turn stopped by an error,
 * "Stopped with error", while `error.notify` is on; titled with the chat's title, or "omp". Only while the window is in
 * the background (`focused` false); an omp that quit or could not start stays in the inbox alone, as omp's terminal
 * raises nothing for it. `seen` holds the entries already looked at, and gains the new ones.
 */
export function settledNotices(
  seen: Set<string>,
  entries: readonly InboxEntry[],
  settings: NotifySettings,
  focused: boolean,
): Notice[] {
  const notices: Notice[] = [];
  for (const entry of entries) {
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    if (focused) continue;
    const summary = entry.title === "" ? "omp" : entry.title;
    if (entry.state === "done" && settings.completion) notices.push({ summary, body: "Complete" });
    if (entry.state === "error" && settings.error)
      notices.push({ summary, body: "Stopped with error" });
  }
  return notices;
}

/**
 * In the desktop window: a turn that ends while the window is in the background, in a chat out of view (the inbox's
 * new entries), raises omp's notification for it (`settledNotices`). In a browser nothing is shown.
 */
export function useSettledNotifications(
  entries: readonly InboxEntry[],
  settings: NotifySettings,
): void {
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(entries.map(entryKey));
  useEffect(() => {
    const notices = settledNotices(
      seen.current ?? new Set(),
      entries,
      settings,
      document.hasFocus(),
    );
    for (const notice of notices) notifyDesktop(notice.summary, notice.body);
  }, [entries, settings]);
}

const settingValue = (entry: ConfigEntry | undefined): unknown =>
  entry !== undefined && !entry.secret ? entry.value : undefined;

/** omp's two notification settings in force for the folder, as its settings file and omp's defaults give them. */
export function useNotifySettings(client: AppClient, folder: FolderPath): NotifySettings {
  const { entries } = useConfig(client, { layer: "global", folder });
  const completion = settingValue(entries.get("completion.notify")) !== "off";
  const error = settingValue(entries.get("error.notify")) === "on";
  return useMemo(() => ({ completion, error }), [completion, error]);
}
