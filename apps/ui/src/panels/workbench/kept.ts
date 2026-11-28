import type { AppClient } from "@omp-app/client";
import type { WorkDraftKey } from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatDraft } from "../../chat/drafts";

/**
 * A Workbench box's text, kept as a chat's message box keeps its own (`ChatDraft`): in this browser at once and on the
 * server a moment later, so leaving the thread, closing the panel or reloading finds it again, and another window shows
 * what was typed there while its own box still shows the old text. `set("")` once it is sent. A key of null keeps
 * nothing (the box has no home yet). The text is "" until the kept one is read, and what was typed meanwhile wins.
 */
export function useKeptText(
  client: AppClient,
  key: WorkDraftKey | null,
): readonly [string, (text: string) => void] {
  const [held, setHeld] = useState<{ readonly key: WorkDraftKey | null; readonly text: string }>({
    key,
    text: "",
  });
  const draft = useRef<ChatDraft | null>(null);
  // Another box: its own text, read below (React's way of resetting state for a new prop).
  if (held.key !== key) setHeld({ key, text: "" });

  useEffect(() => {
    if (key === null) return;
    const kept = ChatDraft.forWork(client, key);
    draft.current = kept;
    let stopFollowing: (() => void) | null = null;
    let gone = false;
    void kept.load().then((text) => {
      if (gone) return;
      setHeld((now) => (now.key === key && now.text === "" ? { key, text } : now));
      stopFollowing = kept.follow((before, next) =>
        setHeld((now) => (now.key === key && now.text === before ? { key, text: next } : now)),
      );
    });
    return () => {
      gone = true;
      stopFollowing?.();
      kept.dispose();
      if (draft.current === kept) draft.current = null;
    };
  }, [client, key]);

  const set = useCallback(
    (text: string) => {
      setHeld({ key, text });
      draft.current?.change(text);
    },
    [key],
  );
  return [held.key === key ? held.text : "", set] as const;
}

/**
 * A value kept as JSON in a Workbench box's text (a question card's answers, the New thread form): `parse` turns the
 * kept text back into one, or null when it cannot, and `fallback` is the value then and before anything was kept.
 */
export function useKeptValue<T>(
  client: AppClient,
  key: WorkDraftKey | null,
  fallback: T,
  parse: (value: unknown) => T | null,
): readonly [T, (value: T) => void, () => void] {
  const [text, setText] = useKeptText(client, key);
  let value = fallback;
  if (text !== "") {
    try {
      value = parse(JSON.parse(text)) ?? fallback;
    } catch {
      // A kept text it cannot read: the fallback, until the box changes.
    }
  }
  const set = useCallback((next: T) => setText(JSON.stringify(next)), [setText]);
  const clear = useCallback(() => setText(""), [setText]);
  return [value, set, clear] as const;
}
