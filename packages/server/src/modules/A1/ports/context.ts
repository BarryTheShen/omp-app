import type { Logger } from "../../../logging";
import type { ProviderAccountStoreService } from "../accounts";
import type { AttachmentStoreService } from "../attachments";
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
import type { SessionPinStoreService } from "../pins";
import type { PlanDocumentStoreService } from "../plans";
import type { RuleStoreService } from "../rules";
import type { SessionImportStoreService } from "../session-import";
import type { SessionFileStore } from "../sessions";
import type { UrlCatalogService } from "../url-catalog";
import type { A1EventPublisher, A1StreamActivity } from "./helper";
/** Stores and host seams composed by the main server; A1 handlers never create parallel stores. */
export interface A1PortContext {
  readonly sessionFileStore: SessionFileStore;
  readonly configStore: ConfigStoreService;
  readonly checkpointStore: CheckpointStoreService;
  readonly draftStore: DraftStoreService;
  readonly ompCommandGateway: OmpCommandGatewayService;
  readonly sessionPinStore: SessionPinStoreService;
  readonly providerAccountStore: ProviderAccountStoreService;
  readonly extensionCatalog: ExtensionCatalogService;
  readonly attachmentStore: AttachmentStoreService;
  readonly memoryStore: MemoryStoreService;
  readonly sessionImportStore: SessionImportStoreService;
  readonly ruleStore: RuleStoreService;
  readonly githubRefs: GithubRefsService;
  readonly urlCatalog: UrlCatalogService;
  readonly planDocumentStore: PlanDocumentStoreService;
  readonly readWorkspaceState?: typeof readWorkspaceState;
  readonly searchWorkspaceFiles?: typeof searchWorkspaceFiles;
  readonly readHostMetadata?: typeof readHostMetadata;
  readonly watchStreamActivity: A1StreamActivity;
  readonly publish: A1EventPublisher;
  /** The app's debug log; absent in tests and embeddings. */
  readonly logger?: Logger;
}
