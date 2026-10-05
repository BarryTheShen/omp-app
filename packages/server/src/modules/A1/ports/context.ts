import type { ProviderAccountStoreService } from "../accounts";
import type { ConfigStoreService } from "../config";
import type { DraftStoreService } from "../drafts";
import type { ExtensionCatalogService } from "../extensions";
import type { searchWorkspaceFiles } from "../file-search";
import type { OmpCommandGatewayService } from "../gateway";
import type { readWorkspaceState } from "../git";
import type { readHostMetadata } from "../host";
import type { SessionPinStoreService } from "../pins";
import type { SessionFileStore } from "../sessions";
import type { A1EventPublisher, A1StreamActivity } from "./helper";
/** Stores and host seams composed by the main server; A1 handlers never create parallel stores. */
export interface A1PortContext {
  readonly sessionFileStore: SessionFileStore;
  readonly configStore: ConfigStoreService;
  readonly draftStore: DraftStoreService;
  readonly ompCommandGateway: OmpCommandGatewayService;
  readonly sessionPinStore: SessionPinStoreService;
  readonly providerAccountStore: ProviderAccountStoreService;
  readonly extensionCatalog: ExtensionCatalogService;
  readonly readWorkspaceState?: typeof readWorkspaceState;
  readonly searchWorkspaceFiles?: typeof searchWorkspaceFiles;
  readonly readHostMetadata?: typeof readHostMetadata;
  readonly watchStreamActivity?: A1StreamActivity;
  readonly publish?: A1EventPublisher;
}
