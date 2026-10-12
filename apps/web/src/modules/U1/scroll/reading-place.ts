import { z } from "zod";

/**
 * Where the reader was in one chat: the message at the top of the transcript, and how far that message's
 * top edge sat from the viewport's top edge. A reload that reopens the chat returns the reader there.
 */
export interface ReadingPlace {
  readonly threadId: string;
  readonly messageId: string;
  readonly offset: number;
}

/** Older pages read, at most, while the saved message is looked for. Past this the reader opens at the newest message. */
export const MAX_OLDER_PAGES = 12;

/** Frames a wait for the transcript to settle may last; past this it decides with what it has. */
const MAX_SETTLE_FRAMES = 60;

const KEY_PREFIX = "omp.app.reading-place.";

const ReadingPlaceSchema = z.object({
  threadId: z.string().min(1),
  // A message still streaming has a provisional `stream:` id that does not exist after a reload.
  messageId: z
    .string()
    .min(1)
    .refine((id) => !id.startsWith("stream:")),
  offset: z.number().finite(),
});

function keyFor(threadId: string): string {
  return `${KEY_PREFIX}${threadId}`;
}

/** The place saved for this chat, or null when none is saved or the saved value does not parse. */
export function readStoredReadingPlace(threadId: string): ReadingPlace | null {
  try {
    const raw = window.localStorage.getItem(keyFor(threadId));
    if (raw === null) return null;
    const parsed = ReadingPlaceSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.threadId === threadId ? parsed.data : null;
  } catch {
    // Storage can be blocked, or hold a value from another version: the chat then opens at its newest message.
    return null;
  }
}

/** Saves the chat's place. Best effort: a store that refuses the write only loses the place. */
export function saveReadingPlace(place: ReadingPlace): void {
  try {
    window.localStorage.setItem(keyFor(place.threadId), JSON.stringify(place));
  } catch {
    // Reload persistence is best effort; the chat stays usable without it.
  }
}

/** Forgets the chat's saved place (the reader is at the newest message). */
export function clearReadingPlace(threadId: string): void {
  try {
    window.localStorage.removeItem(keyFor(threadId));
  } catch {
    // Nothing saved can be forgotten when storage is blocked.
  }
}

/** The same bottom test assistant-ui uses: within one pixel of the end, or nothing to scroll. */
export function isViewportAtBottom(viewport: HTMLElement): boolean {
  return (
    Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= 1 ||
    viewport.scrollHeight <= viewport.clientHeight
  );
}

/**
 * A row's store key: the key the store knows the message by, which survives its streamed copy being replaced (issue 1047).
 * Assistant-ui writes the row's own id to `data-message-id`, so the key is read from `data-store-key`. A row without one
 * (the branch summary) is known by its id.
 */
export function rowStoreKey(row: HTMLElement): string | undefined {
  return row.dataset.storeKey ?? row.dataset.messageId;
}

/** The message row with this store key inside the viewport, or null when it is not on screen yet. */
export function findMessageRow(viewport: HTMLElement, messageId: string): HTMLElement | null {
  for (const row of Array.from(viewport.querySelectorAll<HTMLElement>("[data-message-id]"))) {
    if (rowStoreKey(row) === messageId) return row;
  }
  return null;
}

/**
 * Whether the transcript shows the store's oldest and newest messages. assistant-ui draws a store change in a
 * later render, which can take several frames for a long transcript: until its first and last rows are drawn,
 * a row that is missing is not known to be missing.
 */
export function transcriptCaughtUp(viewport: HTMLElement, order: readonly string[]): boolean {
  const first = order[0];
  const last = order.at(-1);
  if (first === undefined || last === undefined) return true;
  return findMessageRow(viewport, first) !== null && findMessageRow(viewport, last) !== null;
}

/**
 * Calls `done` once the viewport has stopped changing for two frames in a row and `settled` holds, or after
 * `MAX_SETTLE_FRAMES` frames whatever happens, so a streaming reply cannot hold the wait open. Returns a
 * function that cancels the wait.
 */
export function whenViewportSettled(
  viewport: HTMLElement,
  settled: () => boolean,
  done: () => void,
): () => void {
  let changed = false;
  let quietFrames = 0;
  let frames = 0;
  let frame: number | null = null;
  const observer = new MutationObserver(() => {
    changed = true;
  });
  const check = (): void => {
    frame = null;
    frames += 1;
    if (changed) {
      changed = false;
      quietFrames = 0;
    } else {
      quietFrames += 1;
    }
    if ((quietFrames >= 2 && settled()) || frames >= MAX_SETTLE_FRAMES) {
      observer.disconnect();
      done();
      return;
    }
    frame = requestAnimationFrame(check);
  };
  observer.observe(viewport, { childList: true, subtree: true, characterData: true });
  frame = requestAnimationFrame(check);
  return () => {
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
  };
}

/** What a resume does next, given what is loaded: wait, place the saved row, page older history, or open at the bottom. */
export type ResumeStep = "wait" | "restore" | "load-older" | "bottom";

export function nextResumeStep(state: {
  /** The chat's history is still being read; rows may still arrive above and below. */
  readonly historyLoading: boolean;
  /** The saved message is in the transcript now. */
  readonly rowLoaded: boolean;
  /** Older history exists and can be paged in. */
  readonly canLoadOlder: boolean;
  /** An older page is being read right now. */
  readonly pageInFlight: boolean;
}): ResumeStep {
  if (state.historyLoading) return "wait";
  if (state.rowLoaded) return "restore";
  if (!state.canLoadOlder) return "bottom";
  return state.pageInFlight ? "wait" : "load-older";
}
