import {
  AppFailure,
  type ChatSearchMatch,
  ChatSearchPort,
  type ChatSearchState,
  type ChatSearchStatus,
  type ChatSearchTest,
  type SearchChatsArgs,
  type SetChatSearchSettingsArgs,
  type StreamKey,
  streamKey,
} from "@omp-app/contracts";
import type { Logger } from "../../../logging";
import type { PortHandlerContext, PortRegistration } from "../../../registry/ports";
import { embed } from "./embeddings";
import {
  type ChatSearchConfig,
  type ChatSearchFiles,
  readChatSearchConfig,
  shownSettings,
  writeChatSearchConfig,
} from "./settings";

/** The index the search reads (`index.ts`): how far it is, a search, and a nudge after the settings changed. */
export interface ChatSearchIndex {
  status(): ChatSearchStatus;
  search(config: ChatSearchConfig, query: string, limit: number): Promise<ChatSearchMatch[]>;
  /** The settings changed: the indexer reads them again (and starts, or stops). */
  settingsChanged(): void;
}

/** No index: nothing indexed, nothing found (a run without one, the tests of the settings alone). */
export const NO_INDEX: ChatSearchIndex = {
  status: () => ({ chats: 0, indexed: 0, indexing: false, problem: null }),
  search: async () => [],
  settingsChanged: () => {},
};

export interface ChatSearchPortContext {
  readonly files: ChatSearchFiles;
  readonly index: ChatSearchIndex;
  readonly publish: (key: StreamKey, payload: unknown) => unknown;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
}

const asFailure = (failure: unknown): AppFailure =>
  new AppFailure({
    code: "invalid_args",
    message: failure instanceof Error ? failure.message : String(failure),
    retryable: false,
  });

export function createChatSearchRegistration(context: ChatSearchPortContext): PortRegistration & {
  /** Tells the pages the state changed (the index's progress). */
  changed(): void;
} {
  const changedKey = streamKey(ChatSearchPort.name, "changed");
  const changed = (): void => {
    context.publish(changedKey, { at: Date.now() });
  };
  const state = async (): Promise<ChatSearchState> => ({
    settings: shownSettings(await readChatSearchConfig(context.files)),
    status: context.index.status(),
  });
  const handlers = {
    state: async (_args: unknown, _call: PortHandlerContext): Promise<ChatSearchState> =>
      await state(),
    setSettings: async (args: unknown, _call: PortHandlerContext): Promise<ChatSearchState> => {
      const change = args as SetChatSearchSettingsArgs;
      try {
        await writeChatSearchConfig(context.files, change);
      } catch (failure) {
        throw asFailure(failure);
      }
      // The key's value is never logged: only whether one was given.
      context.logger?.info("chat_search.settings", {
        ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
        ...(change.address === undefined ? {} : { address: change.address }),
        ...(change.model === undefined ? {} : { model: change.model }),
        ...(change.key === undefined ? {} : { key: change.key === "" ? "removed" : "set" }),
      });
      context.index.settingsChanged();
      changed();
      return await state();
    },
    test: async (_args: unknown, _call: PortHandlerContext): Promise<ChatSearchTest> => {
      const config = await readChatSearchConfig(context.files);
      const started = performance.now();
      if (config.address === "" || config.model === "") {
        return { ok: false, ms: 0, message: "Set the service's address and model first." };
      }
      try {
        const [vector] = await embed(
          config,
          ["omp app: a test of search by meaning"],
          context.fetch,
        );
        return {
          ok: true,
          ms: Math.round(performance.now() - started),
          dimensions: vector?.length ?? 0,
        };
      } catch (failure) {
        return {
          ok: false,
          ms: Math.round(performance.now() - started),
          message: failure instanceof Error ? failure.message : String(failure),
        };
      }
    },
    search: async (
      args: unknown,
      _call: PortHandlerContext,
    ): Promise<{ matches: ChatSearchMatch[] }> => {
      const { query, limit } = args as SearchChatsArgs;
      const config = await readChatSearchConfig(context.files);
      if (!config.enabled) return { matches: [] };
      try {
        return { matches: await context.index.search(config, query, limit ?? 20) };
      } catch (failure) {
        throw new AppFailure({
          code: "unavailable",
          message: failure instanceof Error ? failure.message : String(failure),
          retryable: true,
        });
      }
    },
  };
  return { port: ChatSearchPort, context, handlers, changed };
}
