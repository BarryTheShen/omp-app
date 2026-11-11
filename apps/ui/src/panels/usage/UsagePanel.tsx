import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  ChatSessionPort,
  type StatsChat,
  StatsPort,
  USAGE_PAUSE_DEFAULT_PERCENT,
  type UsageLimitProvider,
  UsageLimitStore,
  UsageLimitsResult,
  type UsageLimitWindow,
  type UsageSharesResult,
} from "@omp-app/contracts";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useId, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ChatController, ChatUsage } from "../../chat/controller";
import { budgetHold, holdLimitWords, holdResumeWords } from "../../chat/usagePause";
import { follow } from "../../follow";
import { lastSeen } from "../../lastSeen";
import { usePhone } from "../../phone";
import {
  barPercent,
  combinedShare,
  type LimitTone,
  limitTone,
  partWords,
  resetAtWords,
  resetsInWords,
  spendWords,
} from "./usage-words";

/** The budget a chat's field shows before one is set (#14). */
const BUDGET_DEFAULT_PERCENT = 40;

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** A chat's numbers as the panel showed them last, for this page: a panel opened during a turn shows them. */
const keptUsage = (threadId: string) => lastSeen<ChatUsage>(`usage:${threadId}`);

/** The accounts' limits as the panel showed them last, also after a reload: they carry the time they were read. */
const lastAccounts = lastSeen<UsageLimitsResult>("accounts", (stored) => {
  const parsed = UsageLimitsResult.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
});

const FILL: Record<LimitTone, string> = {
  normal: "bg-accent-ink",
  warning: "bg-warn",
  danger: "bg-bad",
};

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * How often the panel's "resets in" words move on. The limits themselves come from the server, which reads them every
 * 5 minutes and every minute near a limit, and sends each read (`changed`, #2781).
 */
const CLOCK_EVERY_MS = 60_000;

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section aria-label={title} className="flex flex-col gap-3 px-4 py-3">
      <h3 className="text-xs font-medium text-t3">{title}</h3>
      {children}
    </section>
  );
}

/**
 * A labelled group of numbers: a heading, then label and value rows; a row's third part is its exact value, shown on
 * hover where the row rounds it; then a note, when there is one.
 */
function Numbers({
  title,
  rows,
  note,
}: {
  readonly title: string;
  readonly rows: readonly (readonly [string, string, string?] | false)[];
  readonly note?: string;
}): ReactNode {
  const shown = rows.filter((row): row is readonly [string, string, string?] => row !== false);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named group of figures, not of form controls, so not a fieldset
    <div role="group" aria-label={title} className="flex flex-col gap-1">
      <h4 className="text-[0.8125rem] font-medium text-t1">{title}</h4>
      {shown.length > 0 && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[0.8125rem]">
          {shown.map(([label, value, exact]) => (
            <div key={label} className="contents">
              <dt className="text-t3">{label}</dt>
              <dd className="text-right text-t1 tabular-nums" title={exact}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {note !== undefined && <p className="text-xs text-pretty text-t3">{note}</p>}
    </div>
  );
}

/** A bar of a share used: filled to its percent, in the tone its share calls for. */
function Bar({
  label,
  percent,
  tone,
  valueText,
}: {
  readonly label: string;
  readonly percent: number;
  readonly tone: LimitTone;
  readonly valueText: string;
}): ReactNode {
  const fill = barPercent(percent);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Number.isFinite(percent) ? Math.round(fill) : undefined}
      aria-valuetext={valueText}
      data-tone={tone}
      className="h-1.5 w-full overflow-hidden rounded-full bg-l2"
    >
      <div className={`h-full rounded-full ${FILL[tone]}`} style={{ width: `${fill}%` }} />
    </div>
  );
}

const count = (value: number): string => value.toLocaleString();

/** A big number in brief: 545.6K, 14.6M. */
const short = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** How often a chat's numbers are read again while its turn runs: omp's counts grow with each finished message. */
const DURING_TURN_EVERY_MS = 10_000;

/**
 * How often a chat's whole history is read again while its turn runs: each read has omp's statistics page read the
 * chats that changed, a few seconds of its work, and a long-running chat may never end its turn while you look.
 */
const WHOLE_DURING_TURN_EVERY_MS = 60_000;

/** A chat's whole history in omp's statistics, or why it could not be read. */
type WholeChat = { readonly chat: StatsChat | null } | { readonly problem: string };

/**
 * The chat's whole history (#19), its subagents' included, from omp's statistics: omp's /session counts only the
 * messages in the chat's context, which a compaction shortens. Read when it shows, every minute while a turn runs and
 * when a turn ends; omp's statistics page reads the chats first, which can take a minute the first time.
 */
function useWholeChat(
  client: AppClient,
  file: string | undefined,
  working: boolean,
): WholeChat | undefined {
  const [read, setRead] = useState<{ readonly file: string; readonly whole: WholeChat } | null>(
    null,
  );
  useEffect(() => {
    if (file === undefined || file === "") return;
    let alive = true;
    let reading = false;
    const readWhole = () => {
      if (reading) return;
      reading = true;
      client
        .port(StatsPort)
        .chat({ file })
        .then(
          ({ chat }) => alive && setRead({ file, whole: { chat } }),
          (failure: unknown) =>
            alive && setRead({ file, whole: { problem: failureText(failure) } }),
        )
        .finally(() => {
          reading = false;
        });
    };
    readWhole();
    const timer = working
      ? window.setInterval(() => {
          if (document.visibilityState === "visible") readWhole();
        }, WHOLE_DURING_TURN_EVERY_MS)
      : undefined;
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [client, file, working]);
  return read !== null && read.file === file ? read.whole : undefined;
}

/** The chat's whole history as omp's statistics hold it: what it spent, its replies, tool calls, subagents and tokens. */
function WholeChatNumbers({ whole }: { readonly whole: WholeChat | undefined }): ReactNode {
  const title = "The whole chat";
  if (whole === undefined) return <Numbers title={title} rows={[]} note="Counting…" />;
  if ("problem" in whole) return <Numbers title={title} rows={[]} note={whole.problem} />;
  const { chat } = whole;
  if (chat === null)
    return (
      <Numbers title={title} rows={[]} note="omp's statistics hold nothing of this chat yet." />
    );
  const unpriced =
    chat.unpriced === 0
      ? ""
      : `; ${count(chat.unpriced)} ${chat.unpriced === 1 ? "reply" : "replies"} had no price and are left out`;
  return (
    <Numbers
      title={title}
      rows={[
        ["Spent", spendWords(chat.cost), `$${chat.cost.toFixed(4)}`],
        ["omp's replies", count(chat.requests)],
        ["Tool calls", count(chat.toolCalls)],
        chat.subagents > 0 && ["Subagents", count(chat.subagents)],
        ["Tokens", short.format(chat.tokens), count(chat.tokens)],
      ]}
      note={`With its subagents, as omp's statistics count it${unpriced}.`}
    />
  );
}

/**
 * The focused chat's numbers: read when it shows, every 10 s while a turn runs, when a turn ends and when its model
 * changes. A busy chat would otherwise show nothing until its turn ends. Its whole history comes from omp's statistics.
 */
function ChatUsageSection({
  chat,
  client,
}: {
  readonly chat: ChatController;
  readonly client: AppClient;
}): ReactNode {
  const working = useSyncExternalStore(
    chat.store.subscribe,
    () => chat.store.getSnapshot().working,
  );
  const live = useSyncExternalStore(
    chat.store.subscribe,
    () => chat.store.getSnapshot().phase === "live",
  );
  const model = useSyncExternalStore(chat.store.subscribe, () => {
    const current = chat.store.getSnapshot().model;
    return current === null ? "" : `${current.provider}/${current.id}`;
  });
  /** The last read, with the chat it was read for: the section stays when the focused chat changes. */
  const [read, setRead] = useState<{
    readonly chat: ChatController;
    readonly usage: ChatUsage;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed model is read again too
  useEffect(() => {
    if (!live) return;
    let alive = true;
    let reading = false;
    const read = () => {
      if (reading) return;
      reading = true;
      chat
        .usage()
        .then((usage) => {
          if (chat.threadId !== null) keptUsage(chat.threadId).set(usage);
          if (!alive) return;
          setRead({ chat, usage });
          setProblem(null);
        })
        .catch(
          (failure: unknown) =>
            alive && setProblem(`Could not read this chat's usage: ${failureText(failure)}`),
        )
        .finally(() => {
          reading = false;
        });
    };
    read();
    const timer = working
      ? window.setInterval(() => {
          if (document.visibilityState === "visible") read();
        }, DURING_TURN_EVERY_MS)
      : undefined;
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [chat, live, working, model]);

  // Until this chat's numbers are read, the ones this page showed last.
  const usage =
    read?.chat === chat
      ? read.usage
      : chat.threadId === null
        ? undefined
        : keptUsage(chat.threadId).get();
  const whole = useWholeChat(client, usage?.stats.sessionFile, working);
  if (usage === undefined)
    return <p className="text-[0.8125rem] text-t3">{problem ?? "Reading…"}</p>;
  const { stats, tokensPerSecond } = usage;
  const context = stats.contextUsage;
  const premium = Math.round((stats.premiumRequests + Number.EPSILON) * 100) / 100;
  return (
    <>
      {context !== undefined && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between text-[0.8125rem]">
            <span className="text-t1">Context</span>
            <span className="text-t1 tabular-nums">{context.percent.toFixed(1)}%</span>
          </div>
          <Bar
            label="Context used"
            percent={context.percent}
            tone="normal"
            valueText={`${count(context.tokens)} of ${count(context.contextWindow)} tokens`}
          />
          <p
            className="text-xs text-t3 tabular-nums"
            title={`${count(context.tokens)} of ${count(context.contextWindow)} tokens`}
          >
            {short.format(context.tokens)} of {short.format(context.contextWindow)} tokens in the
            model's window
          </p>
        </div>
      )}
      {stats.sessionFile !== undefined && stats.sessionFile !== "" && (
        <WholeChatNumbers whole={whole} />
      )}
      {/* omp's own counts. Left out: tool results (one for each call) and the total, which counts omp's notes too. */}
      <Numbers
        title="In its context now"
        rows={[
          stats.cost > 0 && ["Spent", spendWords(stats.cost), `$${stats.cost.toFixed(4)}`],
          premium > 0 && ["Premium requests", premium.toLocaleString()],
          ["Your messages", count(stats.userMessages)],
          ["omp's replies", count(stats.assistantMessages)],
          ["Tool calls", count(stats.toolCalls)],
        ]}
      />
      <Numbers
        title="Tokens in its context now"
        rows={[
          ["New input", short.format(stats.tokens.input), count(stats.tokens.input)],
          stats.tokens.cacheRead > 0 && [
            "Read from the cache",
            short.format(stats.tokens.cacheRead),
            count(stats.tokens.cacheRead),
          ],
          stats.tokens.cacheWrite > 0 && [
            "Written to the cache",
            short.format(stats.tokens.cacheWrite),
            count(stats.tokens.cacheWrite),
          ],
          ["Output", short.format(stats.tokens.output), count(stats.tokens.output)],
        ]}
      />
      {stats.tokens.cacheRead > 0 && (
        <p className="text-xs text-pretty text-t3">
          Each reply sends the conversation to the model again; what it had before comes from the
          cache, which costs less than new input. So the cache's count grows with every reply.
        </p>
      )}
      {tokensPerSecond !== null && (
        <Numbers
          title="Last reply"
          rows={[["Speed", `${tokensPerSecond.toFixed(1)} tokens a second`]]}
        />
      )}
      <p className="text-xs text-pretty text-t3">
        In its context now: omp's /session figures. When omp compacts a chat, a summary takes the
        place of its older messages; the whole chat still counts them.
      </p>
      {problem !== null && <p className="text-xs text-bad-ink">{problem}</p>}
    </>
  );
}

/**
 * One usage window: the share used, its words, and when it resets (the clock time on hover). A window two or more
 * accounts report reads as omp's combined line (#13); one account's, or an account's own, as its share.
 */
function LimitBar({
  name,
  window,
  now,
}: {
  /** Whose window it is, for the bar's name: the provider, or the provider and an account. */
  readonly name: string;
  readonly window: UsageLimitWindow;
  readonly now: Date;
}): ReactNode {
  const combined = combinedShare(window);
  const percent = combined?.percent ?? window.usedPercent;
  const known = Number.isFinite(percent);
  const percentText = !known ? "usage unknown" : (combined?.used ?? `${Math.round(percent)}% used`);
  const reset = resetsInWords(window.resetsAt, now);
  // A server from before #13 sends the fullest account's share alone.
  const below =
    combined !== null
      ? `${combined.left} · ${reset} for the fullest`
      : window.accounts > 1
        ? `${reset} (the fullest of ${window.accounts} accounts)`
        : reset;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.8125rem] text-t1">{window.label}</span>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Bar
            label={`${name}, ${window.label.toLowerCase()} limit`}
            percent={percent}
            tone={limitTone(percent)}
            valueText={`${percentText}, ${below}`}
          />
        </div>
        <span className="shrink-0 text-xs text-t1 tabular-nums">{percentText}</span>
      </div>
      <p className="text-xs text-t3" title={resetAtWords(window.resetsAt, now)}>
        {below}
      </p>
    </div>
  );
}

/**
 * One provider's windows, its accounts combined as omp's short form counts them; with two or more accounts, Each
 * account opens each one's own windows, under the name `omp usage` gives it, its email whole (#13): addresses of one
 * person often differ only at their end.
 */
function ProviderLimits({
  provider,
  now,
  onPause,
}: {
  readonly provider: UsageLimitProvider;
  readonly now: Date;
  /** Pauses or continues every running chat on this provider by hand (#14): how many took it. */
  readonly onPause?: (paused: boolean) => Promise<number>;
}): ReactNode {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const each = useId();
  const accounts = provider.accounts ?? [];
  const pause = (paused: boolean): void => {
    if (onPause === undefined) return;
    setPausing(true);
    setSaid(null);
    onPause(paused)
      .then(
        (chats) =>
          setSaid(
            chats === 0
              ? `No chat runs on ${provider.providerId} now.`
              : `${paused ? "Paused" : "Continued"} ${chats === 1 ? "1 chat" : `${chats} chats`}.`,
          ),
        (failure: unknown) => setSaid(`Not done: ${failureText(failure)}`),
      )
      .finally(() => setPausing(false));
  };
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-t1">
          {provider.providerId}
        </h4>
        {accounts.length > 1 && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded={open}
            aria-controls={each}
            onClick={() => setOpen((shown) => !shown)}
          >
            <ChevronRight
              aria-hidden
              className={`transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
            />
            Each account
          </Button>
        )}
      </div>
      {provider.windows.map((window) => (
        <LimitBar key={window.label} name={provider.providerId} window={window} now={now} />
      ))}
      {onPause !== undefined && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            className={phone ? "h-11" : "tablet:h-11"}
            aria-label={`Pause chats on ${provider.providerId}`}
            disabled={pausing}
            onClick={() => pause(true)}
          >
            Pause chats
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className={phone ? "h-11" : "tablet:h-11"}
            aria-label={`Continue chats on ${provider.providerId}`}
            disabled={pausing}
            onClick={() => pause(false)}
          >
            Continue chats
          </Button>
          {said !== null && (
            <span role="status" className="text-xs text-t3">
              {said}
            </span>
          )}
        </div>
      )}
      {open && (
        <div id={each} className="flex flex-col gap-3 border-l border-l2 pl-3">
          {accounts.map((account) => (
            <section
              key={account.label}
              aria-label={`${provider.providerId}, ${account.label}`}
              className="flex flex-col gap-2"
            >
              <h5 className="text-xs font-medium break-all text-t2">{account.label}</h5>
              {account.windows.map((window) => (
                <LimitBar
                  key={window.label}
                  name={`${provider.providerId} ${account.label}`}
                  window={{ ...window, accounts: 1 }}
                  now={now}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The signed-in accounts' usage limits as omp reports them, read when the panel opens and every minute after; the
 * dashboard shows them too (#2836).
 */
export function AccountsSection({ client }: { readonly client: AppClient }): ReactNode {
  const [result, setResult] = useState<UsageLimitsResult | null>(() => lastAccounts.get() ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let alive = true;
    const show = (found: UsageLimitsResult): void => {
      lastAccounts.set(found);
      if (!alive) return;
      setResult(found);
      setProblem(null);
      setNow(new Date());
    };
    const stop = follow(client.subscribe(UsageLimitStore, "changed"), show);
    client
      .port(UsageLimitStore)
      .read({})
      .then(show)
      .catch(
        (failure: unknown) =>
          alive && setProblem(`Could not read your accounts' usage: ${failureText(failure)}`),
      );
    const timer = setInterval(() => setNow(new Date()), CLOCK_EVERY_MS);
    return () => {
      alive = false;
      stop();
      clearInterval(timer);
    };
  }, [client]);

  if (result === null) return <p className="text-[0.8125rem] text-t3">{problem ?? "Reading…"}</p>;
  if (result.state === "unavailable")
    return <p className="text-[0.8125rem] text-t3">{result.reason}</p>;
  const fetched = new Date(result.fetchedAt);
  return (
    <>
      {result.providers.length === 0 && (
        <p className="text-[0.8125rem] text-t3">omp reports no usage limits for your accounts.</p>
      )}
      {result.providers.map((provider) => (
        <ProviderLimits
          key={provider.providerId}
          provider={provider}
          now={now}
          onPause={(paused) =>
            client
              .port(ChatSessionPort)
              .pauseProvider({ providerId: provider.providerId, paused })
              .then(
                (done) => done.chats,
                (failure: unknown) => {
                  throw failure instanceof AppFailure &&
                    failure.appError.code === "invalid_args" &&
                    failure.appError.omp === undefined
                    ? new Error(
                        "This app server cannot pause a provider's chats yet; it needs an update.",
                      )
                    : failure;
                },
              )
          }
        />
      ))}
      {!Number.isNaN(fetched.getTime()) && (
        <p className="text-xs text-t3">Updated {clock.format(fetched)}</p>
      )}
      {problem !== null && <p className="text-xs text-bad-ink">{problem}</p>}
    </>
  );
}

/** A limit as typed: a whole percent from 1 to 100, or null. */
function percentOf(text: string): number | null {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
}

/**
 * The chat's usage pause (#2781 part 3). Marked, the chat pauses as omp's `/pause` does when its provider's 5-hour
 * window reaches its limit, and resumes when the window resets. The server keeps the mark, so each device shows it.
 */
function UsagePauseSection({ chat }: { readonly chat: ChatController }): ReactNode {
  const phone = usePhone();
  const fieldId = useId();
  const usagePause = useSyncExternalStore(
    chat.store.subscribe,
    () => chat.store.getSnapshot().usagePause,
  );
  const saved = useSyncExternalStore(chat.store.subscribe, () => chat.threadId !== null);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Marked to pause at its own percent; a chat a usage rule holds without a mark has none (#2836). */
  const marked = usagePause !== null && usagePause.percent !== null;
  const shown = draft ?? String(usagePause?.percent ?? USAGE_PAUSE_DEFAULT_PERCENT);

  const set = (percent: number | null): void => {
    setBusy(true);
    setProblem(null);
    chat
      .setUsagePause(percent)
      .then(
        () => setDraft(null),
        (failure: unknown) => setProblem(`Not set: ${failureText(failure)}`),
      )
      .finally(() => setBusy(false));
  };
  /** A typed limit counts once the field is left or Enter is pressed; an unmarked chat keeps it for the switch. */
  const commit = (): void => {
    if (draft === null) return;
    const percent = percentOf(draft);
    if (percent === null) {
      setProblem("Type a whole number from 1 to 100.");
      return;
    }
    if (marked && percent !== usagePause.percent) set(percent);
    else if (marked) setDraft(null);
  };

  return (
    <div data-tour="usage-pause" className="flex flex-col gap-2">
      <label
        htmlFor={fieldId}
        className={`flex items-center justify-between gap-3 text-[0.8125rem] text-t1 ${phone ? "min-h-11" : "tablet:min-h-11"}`}
      >
        Pause this chat at its usage limit
        <Switch
          id={fieldId}
          checked={marked}
          disabled={!saved || busy}
          onCheckedChange={(on) => {
            if (!on) {
              set(null);
              return;
            }
            const percent = percentOf(shown);
            if (percent === null) setProblem("Type a whole number from 1 to 100.");
            else set(percent);
          }}
        />
      </label>
      <div className="flex items-center gap-2 text-[0.8125rem] text-t2">
        At
        <Input
          aria-label="Pause at this percent"
          value={shown}
          inputMode="numeric"
          disabled={!saved || busy}
          aria-invalid={problem !== null && draft !== null}
          className={`dark:bg-transparent text-right ${phone ? "h-11 w-20" : "h-8 w-16 tablet:h-11"}`}
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commit();
          }}
        />
        % of its provider's 5-hour window
      </div>
      <p className="text-xs text-pretty text-t3">
        There, its agents hold at their next step, as with /pause, and the chat goes on when the
        window resets.
      </p>
      {usagePause?.hold != null && !budgetHold(usagePause.hold) && (
        <p role="status" className="text-xs text-warn-ink">
          Paused {holdLimitWords(usagePause.percent, usagePause.hold)} ·{" "}
          {holdResumeWords(usagePause.percent, usagePause.hold)}
        </p>
      )}
      {!saved && (
        <p className="text-xs text-t3">Send a first message, then this chat can be marked.</p>
      )}
      {problem !== null && <p className="text-xs text-bad-ink">{problem}</p>}
    </div>
  );
}

/**
 * The chat's own part of its provider's 5-hour window and its budget (#14). With a budget, the chat pauses as omp's
 * `/pause` does once its own part reaches it, and goes on when the window resets. The part is the server's estimate:
 * the window's growth between its readings, split by what each chat spent. The server keeps the budget, so every device
 * shows it; each fresh reading of the limits moves the part on.
 */
function UsageBudgetSection({
  client,
  chat,
}: {
  readonly client: AppClient;
  readonly chat: ChatController;
}): ReactNode {
  const phone = usePhone();
  const fieldId = useId();
  const saved = useSyncExternalStore(chat.store.subscribe, () => chat.threadId !== null);
  const provider = useSyncExternalStore(
    chat.store.subscribe,
    () => chat.store.getSnapshot().model?.provider ?? null,
  );
  /** What holds the chat, as the server says; a budget's hold names `USAGE_BUDGET_HOLD_RULE`. */
  const hold = useSyncExternalStore(
    chat.store.subscribe,
    () => chat.store.getSnapshot().usagePause?.hold ?? null,
  );
  const [shares, setShares] = useState<UsageSharesResult | null>(null);
  /** The chat's budget as the server keeps it; undefined until read. */
  const [budget, setBudget] = useState<number | null | undefined>(undefined);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const readParts = (): void => {
      chat.usageShares().then(
        (read) => alive && setShares(read),
        (failure: unknown) => alive && setProblem(failureText(failure)),
      );
    };
    readParts();
    chat.usageBudgets().then(
      (read) =>
        alive &&
        setBudget(read.budgets.find((each) => each.threadId === chat.threadId)?.percent ?? null),
      (failure: unknown) => alive && setProblem(failureText(failure)),
    );
    const stop = follow(client.subscribe(UsageLimitStore, "changed"), readParts);
    return () => {
      alive = false;
      stop();
    };
  }, [client, chat]);

  const window =
    provider === null ? undefined : shares?.providers.find((each) => each.providerId === provider);
  const part = window?.chats.find((each) => each.threadId === chat.threadId);
  const set = budget !== undefined && budget !== null;
  const shown = draft ?? String(budget ?? BUDGET_DEFAULT_PERCENT);
  const held = hold !== null && budgetHold(hold);

  const save = (percent: number | null): void => {
    setBusy(true);
    setProblem(null);
    chat
      .setUsageBudget(percent)
      .then(
        () => {
          setBudget(percent);
          setDraft(null);
        },
        (failure: unknown) => setProblem(`Not set: ${failureText(failure)}`),
      )
      .finally(() => setBusy(false));
  };
  /** A typed budget counts once the field is left or Enter is pressed; with none set, it waits for the switch. */
  const commit = (): void => {
    if (draft === null) return;
    const percent = percentOf(draft);
    if (percent === null) {
      setProblem("Type a whole number from 1 to 100.");
      return;
    }
    if (set && percent !== budget) save(percent);
    else if (set) setDraft(null);
  };

  return (
    <div data-tour="usage-budget" className="flex flex-col gap-2">
      {saved && provider !== null && shares !== null && (
        <p className="text-[0.8125rem] text-t2">
          {window === undefined
            ? `No reading of ${provider}'s 5-hour window yet: the part counts from the next one.`
            : part === undefined
              ? `No part of ${provider}'s 5-hour window counted for this chat yet.`
              : `This chat used about ${partWords(part.share)} of ${provider}'s 5-hour window (${spendWords(part.cost)}).`}
        </p>
      )}
      <label
        htmlFor={fieldId}
        className={`flex items-center justify-between gap-3 text-[0.8125rem] text-t1 ${phone ? "min-h-11" : "tablet:min-h-11"}`}
      >
        Pause this chat after its own part
        <Switch
          id={fieldId}
          checked={set}
          disabled={!saved || busy || budget === undefined}
          onCheckedChange={(on) => {
            if (!on) {
              save(null);
              return;
            }
            const percent = percentOf(shown);
            if (percent === null) setProblem("Type a whole number from 1 to 100.");
            else save(percent);
          }}
        />
      </label>
      <div className="flex items-center gap-2 text-[0.8125rem] text-t2">
        At
        <Input
          aria-label="Pause after this chat's own percent"
          value={shown}
          inputMode="numeric"
          disabled={!saved || busy || budget === undefined}
          aria-invalid={problem !== null && draft !== null}
          className={`dark:bg-transparent text-right ${phone ? "h-11 w-20" : "h-8 w-16 tablet:h-11"}`}
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commit();
          }}
        />
        % of its provider's 5-hour window
      </div>
      <p className="text-xs text-pretty text-t3">
        Its part is an estimate: the window's growth between the app's readings, split by what each
        chat spent. There its agents hold at their next step, as with /pause, and it goes on when
        the window resets.
      </p>
      {held && (
        <p role="status" className="text-xs text-warn-ink">
          Paused at its own {budget ?? ""}% · {holdResumeWords(null, hold)}
        </p>
      )}
      {!saved && (
        <p className="text-xs text-t3">Send a first message, then this chat can have a budget.</p>
      )}
      {problem !== null && <p className="text-xs text-bad-ink">{problem}</p>}
    </div>
  );
}

/** Usage, the side column's first panel: the focused chat's numbers and usage pause, and your accounts' limits. */
export function UsagePanel({
  client,
  chat,
}: {
  readonly client: AppClient;
  readonly chat: ChatController | null;
}): ReactNode {
  return (
    <div className="flex flex-col divide-y divide-l2">
      <Section title="This chat">
        {chat === null ? (
          <p className="text-[0.8125rem] text-t3">Open a chat to see its usage.</p>
        ) : (
          <ChatUsageSection key={chat.threadId ?? "new"} chat={chat} client={client} />
        )}
      </Section>
      {chat !== null && (
        <Section title="Pause at the limit">
          <UsagePauseSection key={chat.threadId ?? "new"} chat={chat} />
        </Section>
      )}
      {chat !== null && (
        <Section title="Its own budget">
          <UsageBudgetSection key={chat.threadId ?? "new"} client={client} chat={chat} />
        </Section>
      )}
      <Section title="Your accounts">
        <AccountsSection client={client} />
      </Section>
    </div>
  );
}
