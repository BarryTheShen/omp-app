import type { CapabilityMap, FolderPath, ThreadId } from "@omp-app/contracts";
import type { ReactNode } from "react";
import type { NoSwitchNote } from "@/app/rewind/no-switch-notice";
import type { useAppConnection } from "@/launch";
import type { Surface } from "@/layout";
import type { P3Runs } from "@/modules/P3/runs";
import type { SessionCatalogModel } from "@/modules/R1/catalog/catalog";
import type { SelectedThreadHistoryState } from "@/modules/R1/history";
import type { createNativeRemoteThreadListAdapter } from "@/modules/R1/remote";
import type { ReadingPlace } from "@/modules/U1/scroll";
import type { withPastedText } from "@/modules/U2/attachments";
import type { PromptIntent } from "@/modules/U2/contract";
import type { NewChatOutcome } from "./new-chat-outcome";

/** The attachments a send carries, read when Enter is pressed in the composer that holds them (see `submit` in the view). */
export interface SendAttachments {
  readonly refs: NonNullable<PromptIntent["attachmentRefs"]>;
  readonly complete: Parameters<typeof withPastedText>[1];
}

export interface ActiveThreadProps {
  readonly deliverToOpenChat: (
    intent: PromptIntent,
    attachments: SendAttachments,
    newChatEnd: Promise<NewChatOutcome> | null,
    keptInNewChat: boolean,
  ) => Promise<void>;
  readonly newChatOutcomeNow: () => Promise<NewChatOutcome> | null;
  readonly registerLiveChat: (
    threadId: ThreadId,
    deliver: (intent: PromptIntent, attachments: SendAttachments) => Promise<void>,
    notice?: (note: NoSwitchNote) => void,
  ) => () => void;
  /** Writes a rewind's or fork's note into the chat on screen, when it finished without switching the view. */
  readonly deliverNote: (note: NoSwitchNote) => void;
  readonly client: NonNullable<ReturnType<typeof useAppConnection>["client"]>;
  readonly history: SelectedThreadHistoryState;
  /** A brand-new chat with no saved session: its empty surface is centered even while omp starts. */
  readonly newChat: boolean;
  /** A New chat started from the chat on screen has not replaced it yet: the composer's draft is the folder's new-chat draft. */
  readonly newChatStarting: boolean;
  /** A chat is still opening: its history is loading, or a New chat is starting. The file list waits for it. */
  readonly opening: boolean;
  /** Loads the page of messages older than the ones shown; the thread offers it while history is older. */
  readonly onLoadOlder?: () => Promise<void>;
  /** Loads the full text of a tool output the thread shows shortened. */
  readonly onLoadFullOutput?: (toolCallId: string) => Promise<void>;
  /** Brings the open thread up to date after a command omp saved without a turn: a `!` command, or a compaction. */
  readonly onRefreshAfterCommand?: () => Promise<void>;
  /** Retries the selected chat's initial history after a restart read fails. */
  readonly onRetryHistory: () => Promise<void>;
  readonly capabilities: CapabilityMap;
  readonly folder: FolderPath | null;
  readonly catalog: SessionCatalogModel | null;
  readonly onOpenSettings: (threadId: ThreadId | null, restoreFocus?: HTMLElement) => void;
  readonly remote: ReturnType<typeof createNativeRemoteThreadListAdapter> | null;
  readonly claimReloadTarget: () => (() => void) | undefined;
  readonly onPromptSent: () => void;
  readonly openThread: (threadId: ThreadId) => Promise<void>;
  /** Switches to a chat a branch or a rewind made: it is opened again, whatever its id names (PR 1645). */
  readonly switchChat: (threadId: ThreadId) => Promise<void>;
  readonly pickCount: () => number;
  readonly leftSidebar: ReactNode;
  readonly title: string;
  readonly p3Runs: P3Runs;
  /** The place the reader was in when the page last closed, for the reload that reopens this chat. */
  readonly resumePlace: ReadingPlace | null;
  /** The connection banner's surface: over the chat while the app reconnects (`connection` in `LAYOUT`). */
  readonly connectionSurface: Surface;
  /** The watch notice's surface: over the chat while the server cannot watch some files (`watchNotice` in `LAYOUT`). */
  readonly watchSurface: Surface;
}
