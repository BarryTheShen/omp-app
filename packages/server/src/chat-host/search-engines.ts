/**
 * The chat host's search engine methods (#11, #12): omp's search engines (the `web/<id>` models of its `web` role),
 * where each one's key comes from, a key saved in or removed from omp's own credential store, and one real search to
 * check an engine.
 *
 * A key goes where omp's `/login` puts one, through omp's auth API (never its database), so an auth broker gets it too:
 * - an engine whose provider has omp's API-key login (`login "api-key"` in omp's auth rules: Kagi, Tavily, Exa, …) runs
 *   that login with the key as its answer, so omp's own clean-up and check of the key run before omp stores it;
 * - one whose provider has no login in omp (TinyFish, Keenable, Brave, Jina, Firecrawl) gets the record that login
 *   stores (`{ type: "api_key", source: "login" }`);
 * - one whose provider signs in another way (Kimi Code's device code, Perplexity's account) is left to that sign-in.
 * A new key replaces the keys stored for the provider before it; Remove takes every stored key and leaves a sign-in,
 * the server's environment and omp's models.yml alone. A key is never returned, logged or put in an error.
 */
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import {
  getSearchProvider,
  isRegisteredSearchEngine,
} from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type {
  SearchEngine,
  SearchEngineKey,
  SearchEngineParams,
  SearchEngines,
  SearchTest,
  SetSearchKeyParams,
} from "@omp-app/contracts/chat-host";
import { HostMethodError } from "./method-error";

/**
 * The credentials each engine reads: its provider class's `keys.*` calls (omp 18.18.5, `web/search/providers/<id>.ts`;
 * sofya from omp 18.18.9, which reads the `sofya` key or `SOFYA_API_KEY`).
 * Every engine omp lists is here or in {@link KEYLESS_ENGINES} (`search-engines.test.ts`).
 */
export const ENGINE_KEY_PROVIDERS: Readonly<Record<string, string>> = {
  parallel: "parallel",
  perplexity: "perplexity",
  zai: "zai",
  exa: "exa",
  tinyfish: "tinyfish",
  keenable: "keenable",
  jina: "jina",
  kagi: "kagi",
  tavily: "tavily",
  firecrawl: "firecrawl",
  brave: "brave",
  deepseek: "deepseek",
  kimi: "kimi-code",
  synthetic: "synthetic",
  ollama: "ollama-cloud",
  sofya: "sofya",
};

/**
 * The engines that read no key: page scrapers, SearXNG (an address in omp's settings), Public Web, and Hacker News (its
 * public search API, from omp 18.18.9).
 */
export const KEYLESS_ENGINES: ReadonlySet<string> = new Set([
  "searxng",
  "startpage",
  "duckduckgo",
  "ecosia",
  "google",
  "mojeek",
  "public",
  "hackernews",
]);

/**
 * Where to make a key for the engines omp has no login for, from each engine's own documentation (2026-11-10; Sofya's
 * 2026-11-12: keys are made under API keys on its dashboard and start with `sofya_live_`).
 */
const KEY_PAGES: Readonly<Record<string, { readonly page: string; readonly hint?: string }>> = {
  tinyfish: { page: "https://agent.tinyfish.ai/api-keys", hint: "sk-tinyfish-..." },
  keenable: { page: "https://app.keenable.ai/console", hint: "keen_..." },
  brave: { page: "https://api-dashboard.search.brave.com/app/keys" },
  jina: { page: "https://jina.ai/?sui=apikey" },
  firecrawl: { page: "https://www.firecrawl.dev/app/api-keys", hint: "fc-..." },
  sofya: { page: "https://sofya.co/dashboard#keys", hint: "sofya_live_..." },
};

/** omp's kinds of credential source, in the app's words. */
const KEY_SOURCES: Readonly<Record<string, SearchEngineKey["from"]>> = {
  runtime: "runtime",
  config: "config",
  oauth: "signed_in",
  api_key: "saved",
  env: "environment",
};

/** What a test search asks: common enough that every engine finds pages for it. */
const TEST_QUERY = "wikipedia";
/** How long a test search may take before it counts as no answer. */
const TEST_TIMEOUT_MS = 30_000;

type StoredRow = ReturnType<AuthStorage["credentials"]["list"]>[number];

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The engines in omp's catalog order (`hosted`, the session model's placeholder, is no engine). */
function engineModels(session: AgentSession): Model[] {
  return session.modelRegistry
    .getAll("search")
    .filter((model) => model.provider === "web" && isRegisteredSearchEngine(model.id));
}

function engineModel(session: AgentSession, id: string): Model {
  const model = engineModels(session).find((each) => each.id === id);
  if (model === undefined)
    throw new HostMethodError("invalid_params", `omp has no search engine "${id}".`);
  return model;
}

/** The provider whose keys an engine reads; an engine that reads none has no key to set. */
function keyProviderOf(model: Model): string {
  const provider = ENGINE_KEY_PROVIDERS[model.id];
  if (provider === undefined)
    throw new HostMethodError("invalid_params", `${model.name} needs no key.`);
  return provider;
}

/** The API keys stored for a provider (a sign-in's OAuth rows are not keys). */
function storedKeys(authStorage: AuthStorage, provider: string): StoredRow[] {
  return authStorage.credentials
    .list(provider)
    .filter((row) => row.credential.type === "api_key" && row.disabledCause === null);
}

/** A stored row holding this key, also after omp's login took a `Bearer ` off it (`normalize "strip-bearer"`). */
function holdsKey(row: StoredRow, key: string): boolean {
  return (
    row.credential.type === "api_key" &&
    (row.credential.key === key || row.credential.key === key.replace(/^Bearer\s+/i, ""))
  );
}

/** A provider's chat models are read again after its key changed, as a sign-in does (omp #5780). */
async function refreshModels(session: AgentSession, provider: string): Promise<void> {
  if (!session.modelRegistry.getAll("all").some((model) => model.provider === provider)) return;
  try {
    await session.modelRegistry.refreshProvider(provider, "online");
  } catch {
    // The key is stored either way; the next refresh of the provider's models reads them.
  }
}

async function describeEngine(session: AgentSession, model: Model): Promise<SearchEngine> {
  const { authStorage } = session.modelRegistry;
  let ready = false;
  let whenPicked = false;
  try {
    // omp's own rules for the engine: what its automatic order admits, and what it runs when picked by name.
    const provider = await getSearchProvider(model.id);
    ready = await provider.isAvailable(authStorage, model);
    whenPicked = ready || (await provider.isExplicitlyAvailable(authStorage, model));
  } catch {
    // An engine whose module does not load cannot search.
  }
  const keyProvider = ENGINE_KEY_PROVIDERS[model.id];
  if (keyProvider === undefined) {
    return {
      id: model.id,
      name: model.name,
      access: "none",
      savedKeys: 0,
      ready,
      whenPicked,
      sharedWithModels: false,
    };
  }
  const policy = authPolicyFor(keyProvider);
  const login = policy?.login;
  const source = authStorage.keys.source(keyProvider);
  const page =
    login?.kind === "api-key"
      ? { page: login.authUrl, hint: login.placeholder, help: login.instructions }
      : KEY_PAGES[model.id];
  return {
    id: model.id,
    name: model.name,
    access: login === undefined || login.kind === "api-key" ? "key" : "sign_in",
    keyProvider,
    ...(policy !== undefined && policy.name !== model.name ? { keyProviderName: policy.name } : {}),
    ...(source === undefined
      ? {}
      : {
          key: {
            from: KEY_SOURCES[source.kind] ?? "saved",
            ...(source.envVar === undefined ? {} : { envVar: source.envVar }),
          },
        }),
    savedKeys: storedKeys(authStorage, keyProvider).length,
    ready,
    whenPicked,
    ...(page?.page === undefined ? {} : { keyPage: page.page }),
    ...(page?.hint === undefined ? {} : { keyHint: page.hint }),
    ...(page !== undefined && "help" in page && page.help !== undefined
      ? { keyHelp: page.help }
      : {}),
    sharedWithModels: session.modelRegistry
      .getAll("all")
      .some((each) => each.provider === keyProvider),
  };
}

/**
 * `get_search_engines`: every engine, after taking in keys another chat, omp's terminal or the broker stored; and the
 * order a search tries them in, resolved as omp's web search resolves it (`web/search/index.ts`, `executeSearch`).
 */
export async function readSearchEngines(session: AgentSession): Promise<SearchEngines> {
  try {
    await session.modelRegistry.authStorage.credentials.poll();
  } catch {
    // The store as this chat last read it.
  }
  const { settings, modelRegistry } = session;
  const pool = roleCandidatePool("web", settings, modelRegistry);
  return {
    engines: await Promise.all(
      engineModels(session).map((model) => describeEngine(session, model)),
    ),
    order: resolveRoleChain("web", settings, pool).map(
      ({ model }) => `${model.provider}/${model.id}`,
    ),
    fallbacksSet: Array.isArray(cfgRetryFallbackChains.get(settings).web),
  };
}

/** `set_search_key`: stores the key as omp's `/login` does; it replaces the keys stored for the provider before it. */
export async function setSearchKey(
  session: AgentSession,
  { engine, key }: SetSearchKeyParams,
): Promise<{ engine: SearchEngine }> {
  const model = engineModel(session, engine);
  const keyProvider = keyProviderOf(model);
  const policy = authPolicyFor(keyProvider);
  const login = policy?.login;
  if (login !== undefined && login.kind !== "api-key") {
    throw new HostMethodError(
      "invalid_params",
      `${model.name} signs in with a ${policy?.name ?? keyProvider} account, not a key.`,
    );
  }
  const trimmed = key.trim();
  if (trimmed === "") throw new HostMethodError("invalid_params", "The key is empty.");
  const { authStorage } = session.modelRegistry;
  const before = storedKeys(authStorage, keyProvider);
  try {
    if (login === undefined) {
      await authStorage.credentials.upsert(keyProvider, {
        type: "api_key",
        key: trimmed,
        source: "login",
      });
    } else {
      // omp's API-key login (`registry/engine/api-key.ts`) with the key as the answer to its one question.
      const stored = await authStorage.oauth.login(keyProvider, {
        onAuth: () => {},
        onProgress: () => {},
        onPrompt: async () => trimmed,
      });
      if (stored === undefined) throw new Error(`omp did not store a key for ${model.name}.`);
    }
  } catch (error) {
    // A provider's refusal may quote what it was sent: the key never goes back.
    throw new Error(errorText(error).split(trimmed).join("…"));
  }
  const after = storedKeys(authStorage, keyProvider);
  const added = after.filter((row) => !before.some((old) => old.id === row.id));
  // The same key saved again was updated in place: that row stays.
  const kept = new Set(
    (added.length > 0 ? added : after.filter((row) => holdsKey(row, trimmed))).map((row) => row.id),
  );
  for (const row of before) {
    if (!kept.has(row.id)) await authStorage.credentials.removeById(keyProvider, row.id);
  }
  await refreshModels(session, keyProvider);
  return { engine: await describeEngine(session, model) };
}

/** `remove_search_key`: removes every key stored for the engine's provider. */
export async function removeSearchKey(
  session: AgentSession,
  { engine }: SearchEngineParams,
): Promise<{ engine: SearchEngine; removed: number }> {
  const model = engineModel(session, engine);
  const keyProvider = keyProviderOf(model);
  const { authStorage } = session.modelRegistry;
  let removed = 0;
  for (const row of storedKeys(authStorage, keyProvider)) {
    if (await authStorage.credentials.removeById(keyProvider, row.id)) removed += 1;
  }
  if (removed > 0) await refreshModels(session, keyProvider);
  return { engine: await describeEngine(session, model), removed };
}

/**
 * `test_search`: one real search with the engine alone, through omp's own search (`runSearchQuery`, the path of a
 * chat's `web_search` with the engine picked by name), so a failure reads as omp words it.
 */
export async function testSearch(
  session: AgentSession,
  { engine }: SearchEngineParams,
): Promise<SearchTest> {
  const model = engineModel(session, engine);
  const started = performance.now();
  const ms = (): number => Math.round(performance.now() - started);
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
  try {
    const { details } = await runSearchQuery(
      { query: TEST_QUERY, model: `web/${model.id}`, limit: 3 },
      { modelRegistry: session.modelRegistry, sessionId: session.sessionId, signal },
    );
    if (details.error !== undefined) return { ok: false, ms: ms(), message: details.error };
    return { ok: true, ms: ms(), results: details.response.sources.length };
  } catch (error) {
    return {
      ok: false,
      ms: ms(),
      message: signal.aborted
        ? `${model.name} gave no answer in ${TEST_TIMEOUT_MS / 1_000} s.`
        : errorText(error),
    };
  }
}
