import type { SessionFilePath, ThreadId, UsagePauseHold } from "@omp-app/contracts";
import type { Logger } from "../../../logging";
import type { ProviderAccountStoreService } from "../accounts";
import type { AttachmentStoreService } from "../attachments";
import type { BackgroundJobStopStoreService } from "../background-jobs";
import type { CheckpointStoreService } from "../checkpoints";
import type { ConfigStoreService } from "../config";
import type { DraftStoreService } from "../drafts";
import type { ExtensionCatalogService } from "../extensions";
import type { searchWorkspaceFiles } from "../file-search";
import type { OmpCommandGatewayService } from "../gateway";
import type { readWorkspaceState } from "../git";
import type { GithubRefsService } from "../github-refs";
import type { readHostMetadata } from "../host";
import type { MemoryStoreService } from "../memory";
import type { ModelPreferenceStoreService } from "../model-preferences";
import type { PasteFileStoreService } from "../paste-files";
import type { SessionPinStoreService } from "../pins";
import type { PlanDocumentStoreService } from "../plans";
import type { RuleStoreService } from "../rules";
import type { SessionImportStoreService } from "../session-import";
import type { SessionFileStore } from "../sessions";
import type { UrlCatalogService } from "../url-catalog";
import type { UsageLimitStoreService } from "../usage-limits";
import type { WorkspaceFilesService } from "../workspace-files";
import type { A1EventPublisher, A1StreamActivity } from "./helper";
/** Stores and host seams composed by the main server; A1 handlers never create parallel stores. */
export interface A1PortContext {
  readonly sessionFileStore: SessionFileStore;
  readonly configStore: ConfigStoreService;
  readonly checkpointStore: CheckpointStoreService;
  readonly draftStore: DraftStoreService;
  readonly ompCommandGateway: OmpCommandGatewayService;
  readonly backgroundJobStopStore: BackgroundJobStopStoreService;
  readonly sessionPinStore: SessionPinStoreService;
  /** The model menu's stars and hidden models, in the app's data folder. */
  readonly modelPreferenceStore: ModelPreferenceStoreService;
  readonly providerAccountStore: ProviderAccountStoreService;
  readonly usageLimitStore: UsageLimitStoreService;
  readonly extensionCatalog: ExtensionCatalogService;
  readonly attachmentStore: AttachmentStoreService;
  readonly memoryStore: MemoryStoreService;
  readonly sessionImportStore: SessionImportStoreService;
  readonly ruleStore: RuleStoreService;
  readonly githubRefs: GithubRefsService;
  readonly urlCatalog: UrlCatalogService;
  readonly planDocumentStore: PlanDocumentStoreService;
  readonly pasteFileStore: PasteFileStoreService;
  /** The Files panel's writes, trash and watches (#2782). */
  readonly workspaceFiles: WorkspaceFilesService;
  readonly readWorkspaceState?: typeof readWorkspaceState;
  readonly searchWorkspaceFiles?: typeof searchWorkspaceFiles;
  readonly readHostMetadata?: typeof readHostMetadata;
  readonly watchStreamActivity: A1StreamActivity;
  readonly publish: A1EventPublisher;
  /** Reports when a chat's omp starts or settles a turn and supplies its folder before a session file exists. */
  readonly processBusy?: {
    onBusyChange(listener: (threadId: ThreadId, busy: boolean) => void): () => void;
    folderOf: (threadId: ThreadId) => string | undefined;
  };
  /** The paused chats (omp's `/pause`) of this server's omps by folder, and each change of one, with the chat's folder. */
  readonly processPause?: {
    onPauseChange(
      listener: (threadId: ThreadId, folder: string, pausedAt: number | null) => void,
    ): () => void;
    pausedIn(folder: string): readonly { readonly id: ThreadId; readonly pausedAt: number }[];
  };
  /** Each time a chat's omp names it (#2798): the chat list reads that chat's file again for its title. */
  readonly processTitles?: {
    onTitleChange(listener: (threadId: ThreadId) => void): () => void;
  };
  /** The chats the app continues after a usage limit (#2781) by folder, and each change, with the chat's folder if known. */
  readonly processContinue?: {
    onContinueChange(
      listener: (
        threadId: ThreadId,
        folder: string | undefined,
        continuesAt: number | null,
      ) => void,
    ): () => void;
    continuingIn(
      folder: string,
    ): readonly { readonly id: ThreadId; readonly continuesAt: number }[];
  };
  /** The chats marked to pause at their usage limit (#2781 part 3) by folder, and each change, with the chat's folder. */
  readonly processUsagePause?: {
    onUsagePauseChange(
      listener: (
        threadId: ThreadId,
        folder: string,
        percent: number | null,
        hold: UsagePauseHold | null,
      ) => void,
    ): () => void;
    usagePausesIn(folder: string): readonly {
      readonly id: ThreadId;
      readonly percent: number;
      readonly hold: UsagePauseHold | null;
    }[];
  };
  /** The session file of a chat that is open now. A new chat's file is named before omp writes it to disk. */
  readonly openSessionFile: (threadId: ThreadId) => SessionFilePath | undefined;
  /** The app's debug log; absent in tests and embeddings. */
  readonly logger?: Logger;
}
