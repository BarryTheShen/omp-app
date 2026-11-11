import {
  type ModelHub as Hub,
  type HubModel,
  type HubRole,
  type SearchEngines as Listed,
  SEARCH_KEY_MAX_LENGTH,
  type SearchEngine,
} from "@omp-app/contracts/chat-host";
import { ArrowDown, ArrowUp, ChevronRight, ExternalLink, Eye, EyeOff, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ChatController } from "../chat/controller";
import { lastSeen } from "../lastSeen";
import { SignInProgress } from "../settings/SignInProgress";
import {
  type EngineStanding,
  engineGroups,
  keylessNote,
  keyWords,
  standingOf,
  testWords,
} from "./search";

/** The engines and the order as this page read them last: a reopened page shows them while it reads them again. */
const kept = lastSeen<Listed>("search-engines");

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

const DOTS: Readonly<Record<EngineStanding, string>> = {
  ready: "bg-ok",
  picked: "bg-warn",
  key: "bg-t3",
  setup: "bg-t3",
};

const DOT_WORDS: Readonly<Record<EngineStanding, string>> = {
  ready: "ready",
  picked: "only when picked",
  key: "needs a key or sign-in",
  setup: "not set up",
};

function Dot({ standing }: { readonly standing: EngineStanding | null }): ReactNode {
  return (
    <span
      aria-hidden
      className={`size-2 shrink-0 rounded-full ${standing === null ? "bg-l2" : DOTS[standing]}`}
    />
  );
}

/** Where a key that is not stored in omp comes from, and whether a key saved here takes its place (omp's order). */
function otherKeyWords(engine: SearchEngine): string | null {
  switch (engine.key?.from) {
    case "environment":
      return `Its key comes from ${engine.key.envVar ?? "the server's environment"}. A key saved here is used instead.`;
    case "config":
      return "Its key comes from omp's models.yml, which omp uses before a key saved here.";
    case "runtime":
      return "Its key comes from the key omp was started with (--api-key), which omp uses before a key saved here.";
    case "signed_in":
      return "omp uses the sign-in before a key saved here.";
    default:
      return null;
  }
}

/**
 * The Web search role's page in the Models dialog (#11, #12), the way omp's provider menu shows providers: what a search
 * tries, in order (the role's choice, then its fallbacks, as omp resolves them now), then every search engine omp has,
 * grouped by whether omp can search with it, each saying where its key comes from. A row opens its key (a masked field
 * saved in omp's own store through this chat's omp; the page keeps no copy), the sign-in of an engine that signs in, a
 * real test search, and its place in the order. `generic` is the hub's usual role page, for a chat whose omp predates
 * search keys.
 */
export function SearchEngines({
  controller,
  hub,
  role,
  disabled,
  generic,
  onAssign,
  onFallbacks,
}: {
  readonly controller: ChatController;
  readonly hub: Hub;
  readonly role: HubRole;
  readonly disabled: boolean;
  readonly generic: ReactNode;
  readonly onAssign: (model: HubModel) => void;
  readonly onFallbacks: (chain: readonly string[]) => void;
}): ReactNode {
  const [listed, setListed] = useState<Listed | null>(() => kept.get() ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  /** Chat models that search are many (every chat model with its provider's search): folded until asked for. */
  const [chatModels, setChatModels] = useState(false);
  /** Bumped to read the engines again (after a sign-in). */
  const [reads, setReads] = useState(0);
  /** Each engine's running action and last word, kept here: saving a key moves its row to another group. */
  const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(() => new Map());
  const patchRow = (id: string, patch: Partial<RowState>): void =>
    setRows((now) => new Map(now).set(id, { ...(now.get(id) ?? IDLE), ...patch }));
  // omp's order is its resolution of the role's choice and fallbacks: read again when they change.
  const roleKey = `${role.value ?? ""}\n${role.fallbacks.join("\n")}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the role's choice and fallbacks, and a sign-in, change what omp answers
  useEffect(() => {
    let alive = true;
    controller.searchEngines().then(
      (read) => {
        kept.set(read);
        if (!alive) return;
        setListed(read);
        setProblem(null);
      },
      (failure: unknown) => alive && setProblem(failureText(failure)),
    );
    return () => {
      alive = false;
    };
  }, [controller, roleKey, reads]);

  if (listed === null) {
    return problem === null ? (
      <p className="px-0.5 text-[0.8125rem] text-t3">Reading omp's search engines…</p>
    ) : (
      <>
        <p role="alert" className="text-xs text-bad-ink">
          {problem}
        </p>
        {generic}
      </>
    );
  }

  const { engines, order, fallbacksSet } = listed;
  /** The fallbacks an edit starts from: the role's own, or omp's defaults as resolved when it has none. */
  const base = fallbacksSet ? role.fallbacks : order.slice(1);
  const engineAt = (selector: string): SearchEngine | undefined =>
    engines.find((engine) => `web/${engine.id}` === selector);
  const modelAt = (selector: string): HubModel | undefined =>
    hub.models.find((model) => `${model.provider}/${model.modelId}` === selector);
  const nameOf = (selector: string): string =>
    engineAt(selector)?.name ?? modelAt(selector)?.name ?? selector;
  const move = (selector: string, by: -1 | 1): void => {
    const at = base.indexOf(selector);
    const to = at + by;
    if (at < 0 || to < 0 || to >= base.length) return;
    const next = [...base];
    [next[at], next[to]] = [next[to] as string, next[at] as string];
    onFallbacks(next);
  };
  const changed = (next: SearchEngine): void => {
    const updated = {
      ...listed,
      engines: engines.map((each) => (each.id === next.id ? next : each)),
    };
    kept.set(updated);
    setListed(updated);
  };
  const groups = engineGroups(engines, query);
  // Chat models that search through their own provider, and the session model's placeholder.
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  const others = hub.models.filter(
    (model) =>
      model.roles.includes(role.role) &&
      !engines.some((engine) => model.provider === "web" && model.modelId === engine.id) &&
      words.every((word) =>
        `${model.name} ${model.provider}/${model.modelId}`.toLowerCase().includes(word),
      ),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 max-sm:flex-none">
      <section
        aria-label="Search order"
        data-tour="search-order"
        className="flex shrink-0 flex-col gap-1 rounded-md border border-l2 px-2.5 py-2"
      >
        <p className="text-xs text-t2">
          {order.length === 0
            ? "omp has no engine to search with."
            : `omp searches with the first; when it fails, it tries the next, in order${fallbacksSet ? "" : " (omp's default fallbacks)"}:`}
        </p>
        <ol className="flex flex-col sm:max-h-32 sm:overflow-y-auto">
          {order.map((selector, index) => {
            const engine = engineAt(selector);
            const name = nameOf(selector);
            const editable = index > 0 && base.includes(selector);
            const at = base.indexOf(selector);
            return (
              <li key={selector} className="flex min-h-8 items-center gap-2 text-[0.8125rem]">
                <span className="w-4 shrink-0 text-right text-xs text-t3 tabular-nums">
                  {index + 1}
                </span>
                <Dot standing={engine === undefined ? null : standingOf(engine)} />
                <span className="min-w-0 flex-1 truncate text-t1" title={selector}>
                  {name}
                </span>
                {index === 0 ? (
                  <span className="shrink-0 text-xs text-t3">
                    {role.value === null ? "omp's choice" : "searches first"}
                  </span>
                ) : (
                  engine !== undefined &&
                  standingOf(engine) !== "ready" && (
                    <span className="shrink-0 truncate text-xs text-t3 max-sm:hidden">
                      {keyWords(engine)}
                    </span>
                  )
                )}
                {index > 0 && (
                  <span className="flex shrink-0 items-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${name} earlier`}
                      disabled={disabled || !editable || at === 0}
                      onClick={() => move(selector, -1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${name} later`}
                      disabled={disabled || !editable || at === base.length - 1}
                      onClick={() => move(selector, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${name} from the order`}
                      disabled={disabled || !editable}
                      onClick={() => onFallbacks(base.filter((each) => each !== selector))}
                    >
                      <X />
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        {fallbacksSet && (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="self-start px-0"
            disabled={disabled}
            onClick={() => onFallbacks([])}
          >
            Back to omp's default fallbacks
          </Button>
        )}
      </section>
      <input
        type="search"
        aria-label="Search engines"
        placeholder="Search engines"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="h-8 shrink-0 rounded-md bg-transparent px-2.5 text-[0.8125rem] text-t1 outline-none ring-1 ring-l2 ring-inset placeholder:text-t3 focus-visible:ring-ring"
      />
      {problem !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {problem}
        </p>
      )}
      <div
        data-tour="search-engines"
        className="min-h-32 flex-1 overflow-y-auto max-sm:min-h-0 max-sm:flex-none max-sm:overflow-visible"
      >
        {groups.length === 0 && others.length === 0 && (
          <p className="px-2.5 py-2 text-[0.8125rem] text-t3">No engine matches.</p>
        )}
        {groups.map((group) => (
          <section key={group.standing} aria-label={group.title}>
            <h4 className="px-2.5 pt-2 pb-1 text-xs font-medium text-t3">{group.title}</h4>
            <ul>
              {group.engines.map((engine) => (
                <EngineRow
                  key={engine.id}
                  controller={controller}
                  engine={engine}
                  open={opened === engine.id}
                  place={order.indexOf(`web/${engine.id}`)}
                  inFallbacks={base.includes(`web/${engine.id}`)}
                  model={modelAt(`web/${engine.id}`)}
                  disabled={disabled}
                  onToggle={() => setOpened((now) => (now === engine.id ? null : engine.id))}
                  onChanged={changed}
                  onSignedIn={() => setReads((count) => count + 1)}
                  state={rows.get(engine.id) ?? IDLE}
                  onState={(patch) => patchRow(engine.id, patch)}
                  onAssign={onAssign}
                  onFallbacks={(add) =>
                    onFallbacks(
                      add
                        ? [...base, `web/${engine.id}`]
                        : base.filter((each) => each !== `web/${engine.id}`),
                    )
                  }
                />
              ))}
            </ul>
          </section>
        ))}
        {others.length > 0 && (
          <section aria-label="Chat models that search">
            <button
              type="button"
              aria-expanded={chatModels || query.trim() !== ""}
              onClick={() => setChatModels((shown) => !shown)}
              className="flex w-full items-center gap-1.5 rounded-md px-2.5 pt-2 pb-1 text-left text-xs font-medium text-t3 outline-none hover:text-t2 focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11"
            >
              <ChevronRight
                aria-hidden
                className={`size-3.5 transition-transform motion-reduce:transition-none ${chatModels || query.trim() !== "" ? "rotate-90" : ""}`}
              />
              {`Chat models that search (${others.length})`}
            </button>
            {(chatModels || query.trim() !== "") && (
              <ul>
                {others.map((model) => {
                  const selector = `${model.provider}/${model.modelId}`;
                  const place = order.indexOf(selector);
                  return (
                    <li
                      key={selector}
                      className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2.5 py-1.5"
                    >
                      <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-t1">
                        {model.name}{" "}
                        <span className="font-mono text-xs text-t3 max-sm:hidden">{selector}</span>
                      </span>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={disabled || place === 0}
                        onClick={() => onAssign(model)}
                      >
                        {place === 0 ? "Searches first" : "Search with this first"}
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={disabled || place === 0}
                        onClick={() =>
                          onFallbacks(
                            base.includes(selector)
                              ? base.filter((each) => each !== selector)
                              : [...base, selector],
                          )
                        }
                      >
                        {base.includes(selector) ? "Remove from the order" : "Add as a fallback"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/** What an engine's row is doing, and its last word. */
type Busy = "save" | "remove" | "test" | "sign-in";
interface RowState {
  readonly busy: Busy | null;
  readonly note: { readonly ok: boolean; readonly text: string } | null;
}
const IDLE: RowState = { busy: null, note: null };

/** One engine: its row, and when open, its key, sign-in, test search and place in the order. */
function EngineRow({
  controller,
  engine,
  open,
  place,
  inFallbacks,
  model,
  disabled,
  onToggle,
  onChanged,
  onSignedIn,
  onAssign,
  onFallbacks,
  state,
  onState,
}: {
  readonly controller: ChatController;
  readonly engine: SearchEngine;
  readonly open: boolean;
  /** Its place in the order: 0 searches first, -1 not in it. */
  readonly place: number;
  readonly inFallbacks: boolean;
  /** Its model in the hub, for giving it the role. */
  readonly model: HubModel | undefined;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly onChanged: (engine: SearchEngine) => void;
  readonly onSignedIn: () => void;
  readonly onAssign: (model: HubModel) => void;
  readonly onFallbacks: (add: boolean) => void;
  readonly state: RowState;
  readonly onState: (patch: Partial<RowState>) => void;
}): ReactNode {
  const details = useId();
  const standing = standingOf(engine);
  return (
    <li data-engine={engine.id} className={`rounded-md ${open ? "ring-1 ring-l2 ring-inset" : ""}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={details}
        aria-label={`${engine.name}: ${keyWords(engine)}${place === 0 ? ", searches first" : place > 0 ? `, ${place + 1} in the order` : ""}`}
        onClick={onToggle}
        className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-l1 focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11"
      >
        <ChevronRight
          aria-hidden
          className={`size-3.5 shrink-0 text-t3 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        <Dot standing={standing} />
        <span className="min-w-0 shrink truncate text-[0.8125rem] text-t1">{engine.name}</span>
        {place >= 0 && (
          <span className="shrink-0 text-[11px] text-accent-ink">
            {place === 0 ? "searches first" : `${place + 1} in order`}
          </span>
        )}
        <span className="flex-1" />
        <span className="min-w-0 truncate text-xs text-t2" title={DOT_WORDS[standing]}>
          {keyWords(engine)}
        </span>
      </button>
      {open && (
        <div id={details} className="flex flex-col gap-2 px-2.5 pt-1 pb-3 pl-8">
          <EngineDetails
            key={engine.id}
            controller={controller}
            engine={engine}
            place={place}
            inFallbacks={inFallbacks}
            model={model}
            disabled={disabled}
            onChanged={onChanged}
            onSignedIn={onSignedIn}
            onAssign={onAssign}
            onFallbacks={onFallbacks}
            state={state}
            onState={onState}
          />
        </div>
      )}
    </li>
  );
}

function EngineDetails({
  controller,
  engine,
  place,
  inFallbacks,
  model,
  disabled,
  onChanged,
  onSignedIn,
  onAssign,
  onFallbacks,
  state,
  onState,
}: {
  readonly controller: ChatController;
  readonly engine: SearchEngine;
  readonly place: number;
  readonly inFallbacks: boolean;
  readonly model: HubModel | undefined;
  readonly disabled: boolean;
  readonly onChanged: (engine: SearchEngine) => void;
  readonly onSignedIn: () => void;
  readonly onAssign: (model: HubModel) => void;
  readonly onFallbacks: (add: boolean) => void;
  readonly state: RowState;
  readonly onState: (patch: Partial<RowState>) => void;
}): ReactNode {
  const field = useId();
  const [draft, setDraft] = useState("");
  const [shown, setShown] = useState(false);
  /** The key field shows at once unless a key is saved in omp, which Replace opens it for. */
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, note } = state;
  const setBusy = (next: Busy | null): void => onState({ busy: next });
  const setNote = (next: RowState["note"]): void => onState({ note: next });
  const saved = engine.key?.from === "saved";
  const keyField = engine.access === "key" && (!saved || replacing);
  const providerName = engine.keyProviderName ?? engine.name;

  const test = async (before = ""): Promise<void> => {
    setBusy("test");
    try {
      const result = await controller.testSearch(engine.id);
      setNote({ ok: result.ok, text: `${before}${testWords(result)}` });
    } catch (failure) {
      setNote({ ok: false, text: `${before}${failureText(failure)}` });
    } finally {
      setBusy(null);
    }
  };
  const save = async (): Promise<void> => {
    const key = draft.trim();
    if (key === "") return;
    setBusy("save");
    setNote(null);
    let next: SearchEngine;
    try {
      next = await controller.setSearchKey(engine.id, key);
    } catch (failure) {
      setBusy(null);
      setNote({ ok: false, text: `Not saved: ${failureText(failure)}` });
      return;
    }
    setDraft("");
    setShown(false);
    setReplacing(false);
    onChanged(next);
    // Every saved key is checked with a real search; until it answers, the key is said to be saved.
    setNote({ ok: true, text: "Key saved. Checking it with a search…" });
    await test("Key saved. ");
  };
  const remove = async (): Promise<void> => {
    setConfirming(false);
    setBusy("remove");
    setNote(null);
    try {
      const { engine: next, removed } = await controller.removeSearchKey(engine.id);
      onChanged(next);
      setNote({ ok: true, text: removed === 1 ? "Key removed." : `${removed} keys removed.` });
    } catch (failure) {
      setNote({ ok: false, text: failureText(failure) });
    } finally {
      setBusy(null);
    }
  };
  const signIn = (): void => {
    const provider = engine.keyProvider;
    if (provider === undefined) return;
    setBusy("sign-in");
    setNote(null);
    controller
      .login(provider)
      .then(({ cancelled }) => {
        if (!cancelled) onSignedIn();
      })
      .catch((failure: unknown) =>
        setNote({
          ok: false,
          text: `Could not sign in to ${providerName}: ${failureText(failure)}`,
        }),
      )
      .finally(() => setBusy(null));
  };
  const other = otherKeyWords(engine);
  const keyless = keylessNote(engine);

  return (
    <>
      {keyless !== null && <p className="text-xs text-t2">{keyless}</p>}
      {engine.access === "key" && saved && !replacing && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-t2">
            {engine.savedKeys > 1
              ? `${engine.savedKeys} keys are saved in omp.`
              : "A key is saved in omp."}
          </span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setReplacing(true)}
          >
            Replace key
          </Button>
          {confirming ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-t1">Remove it? omp stops using it.</span>
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={busy !== null}
                onClick={() => void remove()}
              >
                Remove
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </span>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirming(true)}
            >
              Remove key
            </Button>
          )}
        </div>
      )}
      {keyField && (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {other !== null && <p className="text-xs text-t2">{other}</p>}
          <label htmlFor={field} className="text-xs text-t2">
            {`${engine.name} API key`}
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id={field}
              type={shown ? "text" : "password"}
              // Not a password to fill in or remember: the browser offers neither.
              autoComplete="new-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              maxLength={SEARCH_KEY_MAX_LENGTH}
              placeholder={engine.keyHint ?? "API key"}
              value={draft}
              disabled={busy === "save"}
              onChange={(event) => setDraft(event.target.value)}
              className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2.5 font-mono text-[0.8125rem] text-t1 outline-none ring-1 ring-l2 ring-inset placeholder:text-t3 focus-visible:ring-ring max-sm:h-11"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={shown ? "Hide the key" : "Show the key"}
              aria-pressed={shown}
              onClick={() => setShown((now) => !now)}
            >
              {shown ? <EyeOff /> : <Eye />}
            </Button>
            <Button type="submit" size="sm" disabled={draft.trim() === "" || busy !== null}>
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
            {saved && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setReplacing(false);
                  setDraft("");
                  setShown(false);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
          {engine.keyPage !== undefined && (
            <a
              href={engine.keyPage}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 self-start text-xs text-accent-ink underline-offset-2 hover:underline"
            >
              {`Get a ${engine.name} key`}
              <ExternalLink aria-hidden className="size-3" />
            </a>
          )}
          {engine.keyHelp !== undefined && <p className="text-xs text-t3">{engine.keyHelp}</p>}
          {engine.sharedWithModels && (
            <p className="text-xs text-t3">{`This is also ${providerName}'s key for its chat models.`}</p>
          )}
        </form>
      )}
      {engine.access === "sign_in" && (
        <div className="flex flex-col items-start gap-1.5">
          {engine.key?.from === "signed_in" ? (
            <p className="text-xs text-t2">{`Signed in to ${providerName}.`}</p>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={signIn}
            >
              {busy === "sign-in" ? "Waiting…" : `Sign in to ${providerName}`}
            </Button>
          )}
          {busy === "sign-in" && <SignInProgress controller={controller} name={providerName} />}
        </div>
      )}
      {engine.access === "none" && standingOf(engine) === "setup" && (
        <p className="text-xs text-t2">{keyWords(engine)}.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled || place === 0 || model === undefined}
          onClick={() => {
            if (model !== undefined) onAssign(model);
          }}
        >
          {place === 0 ? "Searches first" : "Search with this first"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled || place === 0}
          onClick={() => onFallbacks(!inFallbacks)}
        >
          {inFallbacks ? "Remove from the order" : "Add as a fallback"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => {
            setNote(null);
            void test();
          }}
        >
          {busy === "test" ? "Searching…" : "Test search"}
        </Button>
      </div>
      {note !== null && (
        <p role="status" className={`text-xs ${note.ok ? "text-ok-ink" : "text-bad-ink"}`}>
          {note.text}
        </p>
      )}
    </>
  );
}
