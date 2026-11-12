import type {
  AbortSignalLike,
  AppHealth,
  CapabilityMap,
  FolderPath,
  ModelChoice,
  SessionFilePath,
  ThreadId,
  UsableModel,
  UsageLimitsResult,
  UsagePaceResult,
} from "@omp-app/contracts";
import type { Logger } from "../../logging";
import type { FileWatchRegistry } from "../../modules/A1/fs/file-watch-registry";
import type { UsageShares } from "../../modules/A1/usage-limits/shares";
import type { ExternalOmpState, OmpProcessRegistry, ProcessTimer } from "../../process";
import type { EventReplayHub } from "../../replay";
import type { CallingChat } from "../../todos/agent";

/** How a chat starts: its id and file (a provisional pair until its host names its own), and omp's launch flags. */
export interface ThreadBootstrap {
  readonly threadId: ThreadId;
  readonly folderPath: FolderPath;
  readonly sessionFile: SessionFilePath;
  readonly args?: readonly string[];
  readonly model?: ModelChoice;
}

/** What A0's ports need from the server: the chats' processes, the replay, the catalog seams and the server's facts. */
export interface A0PortContext {
  readonly processRegistry: OmpProcessRegistry;
  /**
   * Keeps a new chat started ahead in the folders new chats were opened in last, so the next "New chat" there opens at
   * once (#2760). The app turns it on; absent, every new chat starts its omp when it is opened.
   */
  readonly newChatsReady?: boolean;
  /** The timer that replaces a new chat kept ready before it ages out (#2768); the global one when absent. */
  readonly spareTimer?: ProcessTimer;
  /** Whether another omp holds a chat's lease (`active`), asked before an open starts omp for it. Absent: no check. */
  readonly leaseProbe?: (sessionId: string) => Promise<"active" | "inactive" | "unknown">;
  readonly replay: EventReplayHub;
  readonly capabilities: CapabilityMap;
  readonly serverInfo: {
    readonly instanceId: string;
    readonly serverVersion: string;
    readonly launchFolder: FolderPath;
    readonly omp: { readonly version: string } | null;
    /** Where the debug log is written; absent without one. */
    readonly logFile?: string;
  };
  readonly health: AppHealth;
  /** The watched files, when the server watches them: their failures show in the health the page reads. */
  readonly fileWatch?: FileWatchRegistry;
  /** Required catalog seam: A1 resolves the omp-authoritative session file and cwd for a ThreadId. */
  readonly resolveThread: (
    threadId: ThreadId,
    signal: AbortSignalLike,
  ) => Promise<ThreadBootstrap | undefined>;
  /**
   * The chat omp's `--continue` opens in a folder, found before omp starts: omp says which chat it opened only once it
   * runs. Undefined when the folder has no chat to continue.
   */
  readonly latestThread: (
    folderPath: FolderPath,
    signal: AbortSignalLike,
  ) => Promise<{ readonly threadId: ThreadId; readonly sessionFile: SessionFilePath } | undefined>;
  /**
   * Whether another omp is writing a chat (omp's lease on the chat's file). A rename of a chat nobody
   * has open goes ahead only on "none": omp writes a chat to a copy when another process holds its file.
   */
  readonly externalOmp: (
    threadId: ThreadId,
    sessionFile: SessionFilePath,
    /** The rename host this runtime started for the chat: it is not another omp. */
    hostPid: number | undefined,
  ) => Promise<ExternalOmpState>;
  /**
   * Whether a chat's session file is on disk. omp writes a new chat's file only once its first turn has
   * been saved, so a chat whose omp stopped before that has nothing to resume. Defaults to the file system.
   */
  readonly sessionFileExists?: (sessionFile: SessionFilePath) => Promise<boolean>;
  /** The debug log; browser-reported errors are written to it. */
  readonly logger?: Logger;
  /** Builds the debug report the browser can save; absent when the app runs without a debug log. */
  readonly debugReport?: () => Promise<{ readonly fileName: string; readonly text: string }>;
  /** Lists the models omp can use now (`omp models --json`), for the picker that opens a chat omp cannot restore. */
  readonly usableModels?: () => Promise<readonly UsableModel[]>;
  /**
   * Where the app keeps the chats it continues itself after a usage limit (#2781; `<app data>/usage-resume.json`).
   * Absent: continuing is left to omp's own retry.
   */
  readonly usageResumeFile?: string;
  /** The clock and timer of those continues; the real ones when absent (tests move them by hand). */
  readonly usageResumeClock?: { readonly now: () => number; readonly timer: ProcessTimer };
  /**
   * Where the app keeps the chats marked to pause at their usage limit, the usage rules (#2836) and the holds on them
   * (#2781 part 3; `<app data>/usage-pause.json`). Absent: no chat pauses at a usage limit.
   */
  readonly usagePauseFile?: string;
  /** Where the chats' budgets and the usage rules' scopes are kept (#14; `<app data>/usage-pause-extras.json`). */
  readonly usagePauseExtrasFile?: string;
  /** Each chat's part of its provider's 5-hour window (#14), from its replies; absent: no parts, and budgets never hold. */
  readonly usageShares?: UsageShares;
  /** The server's own usage reads (the usage watch), which the usage pause judges; absent: it never pauses a chat. */
  readonly usageLimits?: {
    readonly subscribe: (listener: (result: UsageLimitsResult) => void) => () => void;
  };
  /** Each window's pace from the server's readings (#2836), for the rules' pace condition; absent: it never holds. */
  readonly usagePace?: () => UsagePaceResult;
  /**
   * Answers a chat's `shared_todos` call (`app.todos`, D7) from the to-do list, the chat named by its id and folder;
   * absent: the tool says the app keeps no list.
   */
  readonly todos?: {
    readonly agentCall: (
      chat: Omit<CallingChat, "title">,
      call: unknown,
    ) => Promise<import("@omp-app/contracts/chat-host").ToolCallAnswer>;
  };
  /** Hears each chat's questions as they change (D7), for the dashboard's list of every chat's questions. */
  readonly questions?: {
    readonly record: (
      threadId: ThreadId,
      folder: FolderPath,
      record: import("@omp-app/contracts/chat-host").QuestionRecord,
    ) => void;
  };
}
