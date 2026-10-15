import type { ThreadId } from "@omp-app/contracts";
import type { NotificationProjector } from "@/modules/N1/notifications";
import type { ConversationTransitionPort } from "@/modules/P4/transitions";

/** The two parts of N1's projector a rewind writes its note into: the bus and the transcript store. */
export type NoticeChannel = Pick<NotificationProjector, "getBus" | "getTranscript">;

/**
 * What a rewind or fork says in the chat the person picked, when it finished and the view did not switch to its new
 * chat. It says only what the app can see: the transition finished, and the chat the person picked stays open.
 */
export interface NoSwitchNote {
  readonly source: "rewind" | "fork";
  readonly dedupeKey: string;
  readonly message: string;
}

export const REWIND_NO_SWITCH_NOTE: NoSwitchNote = {
  source: "rewind",
  dedupeKey: "rewind:no-switch",
  message: "The rewind finished. The chat you picked stays open.",
};

export const FORK_NO_SWITCH_NOTE: NoSwitchNote = {
  source: "fork",
  dedupeKey: "fork:no-switch",
  message: "The fork finished. The chat you picked stays open.",
};

/**
 * Calls `note` when a rewind or fork finished (it was not cancelled) and the view did not switch. A cancelled
 * transition says nothing here, and a failed one rejects to its caller, which shows its own message.
 */
export function withNoSwitchNote(
  port: ConversationTransitionPort,
  note: (value: NoSwitchNote) => void,
): ConversationTransitionPort {
  return {
    getCapabilities: () => port.getCapabilities(),
    updateCapabilities: (capabilities) => port.updateCapabilities(capabilities),
    getRetainedSource: () => port.getRetainedSource(),
    clearRetainedSource: () => port.clearRetainedSource(),
    async branch(request) {
      const result = await port.branch(request);
      if (!result.cancelled && !result.reloaded) note(REWIND_NO_SWITCH_NOTE);
      return result;
    },
    async fork(request) {
      const result = await port.fork(request);
      if (!result.cancelled && !result.reloaded) note(FORK_NO_SWITCH_NOTE);
      return result;
    },
  };
}

/**
 * Writes the note into the chat `threadId` names, the same two writes N1's projector makes for a transcript notice: the
 * bus and the transcript. It is informational, so it is not read aloud (`live: "off"`, as the session notices are).
 */
export function showNoSwitchNote(
  channel: NoticeChannel,
  threadId: ThreadId,
  note: NoSwitchNote,
): void {
  const notification = {
    threadId,
    dedupeKey: note.dedupeKey,
    severity: "info",
    placement: "transcript",
    message: note.message,
    source: note.source,
    live: "off",
    focus: "preserve",
  } as const;
  channel.getBus().publish(notification);
  channel.getTranscript().upsert(notification);
}

/** A chat's view as the root registers it: the chat it shows, and how a note reaches it. */
export interface NoteView {
  readonly threadId: ThreadId;
  readonly notice?: (note: NoSwitchNote) => void;
}

/** What a note needs from the root: the open chat, its registered view, and when a view registers. */
export interface NoteRoute {
  /** Resolves when the open chat has finished opening, or has failed to open. */
  readonly whenSettled: () => Promise<void>;
  /** The chat the person has open, or undefined when no chat opened. */
  readonly openThreadId: () => ThreadId | undefined;
  /** The view registered most recently, or null while none is registered. */
  readonly view: () => NoteView | null;
  /** Resolves at the next view registration. */
  readonly nextView: () => Promise<void>;
}

/**
 * Writes `note` through the view of the chat the person has open. While that chat is still opening, the note waits for
 * the chat's view to come on screen, as a send does; it is never written through another chat's view. With no chat open
 * there is nothing to write in, so nothing is written.
 */
export async function deliverNoteWhenOpen(route: NoteRoute, note: NoSwitchNote): Promise<void> {
  for (;;) {
    await route.whenSettled();
    const open = route.openThreadId();
    if (open === undefined) return;
    const view = route.view();
    if (view !== null && view.threadId === open) {
      view.notice?.(note);
      return;
    }
    await route.nextView();
  }
}
