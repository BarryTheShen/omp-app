import type {
  AbortSignalLike,
  AppHealth,
  CapabilityMap,
  FolderPath,
  ModelChoice,
  SessionFilePath,
  ThreadId,
  UsableModel,
} from "@omp-app/contracts";
import type { Logger } from "../../logging";
import type { FileWatchRegistry } from "../../modules/A1/fs/file-watch-registry";
import type { ExternalOmpState, OmpProcessRegistry } from "../../process";
import type { EventReplayHub } from "../../replay";

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
}
