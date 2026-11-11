import type { AppClient } from "@omp-app/client";
import {
  USAGE_PAUSE_DEFAULT_PERCENT,
  type UsageLimitProvider,
  UsageLimitStore,
  UsageLimitsResult,
  type UsageLimitWindow,
} from "@omp-app/contracts";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useId, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ChatController, ChatUsage } from "../../chat/controller";
import { holdLimitWords, holdResumeWords } from "../../chat/usagePause";
import { follow } from "../../follow";
import { lastSeen } from "../../lastSeen";
import { usePhone } from "../../phone";
import {
  barPercent,
  combinedShare,
  type LimitTone,
  limitTone,
  resetAtWords,
  resetsInWords,
} from "./usage-words";

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

/** A labelled group of numbers, as omp's `/session` prints them: a heading, then label and value rows. */
function Numbers({
  title,
  rows,
}: {
  readonly title: string;
  readonly rows: readonly (readonly [string, string] | false)[];
}): ReactNode {
  const shown = rows.filter((row): row is readonly [string, string] => row !== false);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named group of figures, not of form controls, so not a fieldset
    <div role="group" aria-label={title} className="flex flex-col gap-1">
      <h4 className="text-[0.8125rem] font-medium text-t1">{title}</h4>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[0.8125rem]">
        {shown.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-t3">{label}</dt>
            <dd className="text-right text-t1 tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
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

/** How often a chat's numbers are read again while its turn runs: omp's counts grow with each finished message. */
const DURING_TURN_EVERY_MS = 10_000;

/**
 * The focused chat's numbers: read when it shows, every 10 s while a turn runs, when a turn ends and when its model
 * changes. A busy chat would otherwise show nothing until its turn ends.
 */
function ChatUsageSection({ chat }: { readonly chat: ChatController }): ReactNode {
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
          <p className="text-xs text-t3 tabular-nums">
            {count(context.tokens)} of {count(context.contextWindow)} tokens
          </p>
        </div>
      )}
      {tokensPerSecond !== null && (
        <Numbers title="Last reply" rows={[["Speed", `${tokensPerSecond.toFixed(1)} tok/s`]]} />
      )}
      <Numbers
        title="Messages"
        rows={[
          ["User", count(stats.userMessages)],
          ["Assistant", count(stats.assistantMessages)],
          ["Tool Calls", count(stats.toolCalls)],
          ["Tool Results", count(stats.toolResults)],
          ["Total", count(stats.totalMessages)],
        ]}
      />
      <Numbers
        title="Tokens"
        rows={[
          ["Input", count(stats.tokens.input)],
          ["Output", count(stats.tokens.output)],
          stats.tokens.cacheRead > 0 && ["Cache Read", count(stats.tokens.cacheRead)],
          stats.tokens.cacheWrite > 0 && ["Cache Write", count(stats.tokens.cacheWrite)],
          ["Total", count(stats.tokens.total)],
        ]}
      />
      {(stats.cost > 0 || premium > 0) && (
        <Numbers
          title="Cost"
          rows={[
            stats.cost > 0 && ["Total", stats.cost.toFixed(4)],
            premium > 0 && ["Premium Requests", premium.toLocaleString()],
          ]}
        />
      )}
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
}: {
  readonly provider: UsageLimitProvider;
  readonly now: Date;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const each = useId();
  const accounts = provider.accounts ?? [];
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
        <ProviderLimits key={provider.providerId} provider={provider} now={now} />
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
      <p className="text-xs text-t3">
        There, its agents hold at their next step, as with /pause, and the chat goes on when the
        window resets.
      </p>
      {usagePause?.hold != null && (
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
          <ChatUsageSection key={chat.threadId ?? "new"} chat={chat} />
        )}
      </Section>
      {chat !== null && (
        <Section title="Pause at the limit">
          <UsagePauseSection key={chat.threadId ?? "new"} chat={chat} />
        </Section>
      )}
      <Section title="Your accounts">
        <AccountsSection client={client} />
      </Section>
    </div>
  );
}
