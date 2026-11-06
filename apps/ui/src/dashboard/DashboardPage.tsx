import type { AppClient } from "@omp-app/client";
import {
  ChatSessionPort,
  type RunningChat,
  type ThreadId,
  UsageLimitStore,
  type UsagePaceResult,
  type UsagePauseHold,
  type UsageQueueResult,
  type UsageRule,
  type UsageRulesResult,
} from "@omp-app/contracts";
import { ArrowDown, ArrowUp, ChevronLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { follow } from "../follow";
import { AccountsSection } from "../panels/usage/UsagePanel";
import { useRunningChats } from "../sidebar/useRunningChats";

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** What a call says when the server is older than the dashboard: the part comes with the next server update. */
const OLD_SERVER = /Unknown method/;

/** The words for a call that failed: the server's own, or that it comes with the next server update. */
function problemWords(doing: string, failure: unknown): string {
  const text = failureText(failure);
  return OLD_SERVER.test(text)
    ? `${doing} comes with the next server update.`
    : `Could not ${doing.toLowerCase()}: ${text}`;
}

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** A moment as a clock time, with its day when it is more than a day away. */
function whenWords(at: number, now: number): string {
  return Math.abs(at - now) < 24 * 3_600_000 ? time.format(at) : dayTime.format(at);
}

/** How often the pace, the rules and the queue are read again while the page is open. */
const READ_EVERY_MS = 30_000;

function Section({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 border-b border-l2 px-4 py-4 last:border-b-0"
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium text-t1">{title}</h3>
        {hint !== undefined && <p className="text-xs text-t3">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** Each window's pace from the server's readings of the last hour, read again with every usage read. */
function PaceSection({ client }: { readonly client: AppClient }): ReactNode {
  const [pace, setPace] = useState<UsagePaceResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      client
        .port(UsageLimitStore)
        .pace({})
        .then((found) => {
          if (!alive) return;
          setPace(found);
          setProblem(null);
        })
        .catch((failure: unknown) => alive && setProblem(problemWords("The pace", failure)));
    };
    read();
    const stop = follow(client.subscribe(UsageLimitStore, "changed"), read);
    return () => {
      alive = false;
      stop();
    };
  }, [client]);
  if (problem !== null) return <p className="text-[0.8125rem] text-t3">{problem}</p>;
  if (pace === null) return <p className="text-[0.8125rem] text-t3">Reading…</p>;
  if (pace.windows.length === 0)
    return (
      <p className="text-[0.8125rem] text-t3">
        No readings yet: the server keeps them from its next usage read.
      </p>
    );
  const now = Date.now();
  return (
    <ul className="flex flex-col gap-1.5">
      {pace.windows.map((window) => {
        const fullAt = window.fullAt === null ? null : Date.parse(window.fullAt);
        const words =
          window.perHour === null
            ? "not enough readings in the last hour for a pace yet"
            : `${window.perHour.toFixed(1)}% an hour${
                fullAt !== null && Number.isFinite(fullAt)
                  ? `: full at ${whenWords(fullAt, now)}`
                  : window.atReset !== null
                    ? `: about ${Math.round(window.atReset)}% at its reset`
                    : ""
              }`;
        return (
          <li key={`${window.providerId}\u0000${window.label}`} className="text-[0.8125rem]">
            <span className="text-t1">
              {window.providerId}, {window.label}
            </span>
            <span className="text-t3"> · {words}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** A rule's conditions in words: "5-hour window at 85% · 08:00 to 23:00". */
function conditionWords(rule: UsageRule): string {
  const parts: string[] = [];
  if (rule.fiveHourAt !== null) parts.push(`5-hour window at ${rule.fiveHourAt}%`);
  if (rule.weeklyAt !== null) parts.push(`weekly window at ${rule.weeklyAt}%`);
  if (rule.paceAt !== null) parts.push(`pace past ${rule.paceAt}% at the reset`);
  if (rule.hours !== null) parts.push(`${rule.hours.from} to ${rule.hours.to}`);
  return parts.join(" · ");
}

/** Why a held chat waits, in words: what holds it, and until when. */
function holdWords(hold: UsagePauseHold, rules: readonly UsageRule[], now: number): string {
  const rule = rules.find((each) => each.id === hold.rule);
  const until = hold.until === null ? "" : ` until ${whenWords(hold.until, now)}`;
  const by = rule === undefined ? "Its own limit" : rule.name;
  switch (hold.reason ?? "five_hour") {
    case "five_hour":
      return `${by}: the 5-hour window is at its limit${until}`;
    case "weekly":
      return `${by}: the weekly window is at its limit${until}`;
    case "pace":
      return `${by}: the 5-hour window would pass its line before the reset${until}`;
    case "hours":
      return `${by}: inside its hours${until}`;
  }
}

/** A chat's name: as the running chats list has it, else its first characters. */
function chatName(id: ThreadId, running: readonly RunningChat[]): string {
  const chat = running.find((each) => each.threadId === id);
  if (chat?.title !== null && chat?.title !== undefined) return chat.title;
  return chat === undefined ? `A chat not running (${id.slice(0, 8)})` : "New chat";
}

const NEW_RULE: Omit<UsageRule, "id"> = {
  name: "Day hours",
  chats: [],
  fiveHourAt: 85,
  weeklyAt: null,
  paceAt: null,
  hours: { from: "08:00", to: "23:00" },
  enabled: true,
};

/** A whole percent from 1 to 100 as typed, or null. */
function percentOf(text: string): number | null {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
}

/** One condition of the editor: a switch, and its value. */
function Condition({
  label,
  on,
  onOn,
  children,
}: {
  readonly label: string;
  readonly on: boolean;
  readonly onOn: (on: boolean) => void;
  readonly children: ReactNode;
}): ReactNode {
  const id = useId();
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-2">
      <Switch id={id} checked={on} onCheckedChange={onOn} />
      <label htmlFor={id} className="text-[0.8125rem] text-t1">
        {label}
      </label>
      {on && children}
    </div>
  );
}

/** The editor of one rule: its name, its chats and its conditions. */
function RuleEditor({
  rule,
  running,
  onSave,
  onCancel,
}: {
  readonly rule: UsageRule;
  readonly running: readonly RunningChat[];
  readonly onSave: (rule: UsageRule) => Promise<void>;
  readonly onCancel: () => void;
}): ReactNode {
  const [name, setName] = useState(rule.name);
  const [chats, setChats] = useState<readonly ThreadId[]>(rule.chats);
  const [fiveHour, setFiveHour] = useState(rule.fiveHourAt === null ? "" : String(rule.fiveHourAt));
  const [fiveHourOn, setFiveHourOn] = useState(rule.fiveHourAt !== null);
  const [weekly, setWeekly] = useState(rule.weeklyAt === null ? "90" : String(rule.weeklyAt));
  const [weeklyOn, setWeeklyOn] = useState(rule.weeklyAt !== null);
  const [pace, setPace] = useState(rule.paceAt === null ? "95" : String(rule.paceAt));
  const [paceOn, setPaceOn] = useState(rule.paceAt !== null);
  const [from, setFrom] = useState(rule.hours?.from ?? "08:00");
  const [to, setTo] = useState(rule.hours?.to ?? "23:00");
  const [hoursOn, setHoursOn] = useState(rule.hours !== null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameId = useId();
  const listed = [
    ...running.map((chat) => chat.threadId),
    ...chats.filter((id) => !running.some((chat) => chat.threadId === id)),
  ];

  const save = async (): Promise<void> => {
    const fiveHourAt = fiveHourOn ? percentOf(fiveHour) : null;
    const weeklyAt = weeklyOn ? percentOf(weekly) : null;
    const paceAt = paceOn ? percentOf(pace) : null;
    if (
      (fiveHourOn && fiveHourAt === null) ||
      (weeklyOn && weeklyAt === null) ||
      (paceOn && paceAt === null)
    ) {
      setProblem("A percent is a whole number from 1 to 100.");
      return;
    }
    if (hoursOn && from === to) {
      setProblem("The hours start and end at the same time.");
      return;
    }
    if (!fiveHourOn && !weeklyOn && !paceOn && !hoursOn) {
      setProblem("Turn on at least one condition.");
      return;
    }
    if (name.trim() === "") {
      setProblem("Give the rule a name.");
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await onSave({
        ...rule,
        name: name.trim(),
        chats: [...chats],
        fiveHourAt,
        weeklyAt,
        paceAt,
        hours: hoursOn ? { from, to } : null,
      });
    } catch (failure) {
      setProblem(problemWords("Saving rules", failure));
      setSaving(false);
    }
  };

  return (
    <form
      aria-label="Edit rule"
      className="flex flex-col gap-3 rounded-lg border border-l2 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-xs text-t3">
          Name
        </label>
        <Input
          id={nameId}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs text-t3">Pause when any of these holds</legend>
        <Condition label="the 5-hour window is at" on={fiveHourOn} onOn={setFiveHourOn}>
          <Input
            aria-label="5-hour window percent"
            inputMode="numeric"
            className="w-16"
            value={fiveHour}
            onChange={(event) => setFiveHour(event.target.value)}
          />
          <span className="text-[0.8125rem] text-t3">%</span>
        </Condition>
        <Condition label="the weekly window is at" on={weeklyOn} onOn={setWeeklyOn}>
          <Input
            aria-label="Weekly window percent"
            inputMode="numeric"
            className="w-16"
            value={weekly}
            onChange={(event) => setWeekly(event.target.value)}
          />
          <span className="text-[0.8125rem] text-t3">%</span>
        </Condition>
        <Condition label="the pace would pass" on={paceOn} onOn={setPaceOn}>
          <Input
            aria-label="Pace percent"
            inputMode="numeric"
            className="w-16"
            value={pace}
            onChange={(event) => setPace(event.target.value)}
          />
          <span className="text-[0.8125rem] text-t3">% at the 5-hour window's reset</span>
        </Condition>
        <Condition label="the clock is between" on={hoursOn} onOn={setHoursOn}>
          <Input
            aria-label="From"
            type="time"
            className="w-28"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          <span className="text-[0.8125rem] text-t3">and</span>
          <Input
            aria-label="To"
            type="time"
            className="w-28"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </Condition>
        <p className="text-xs text-t3">
          A chat pauses at its next step and continues once none of these holds any more. A chat you
          resume by hand runs on until the condition next starts.
        </p>
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs text-t3">The chats it pauses</legend>
        {listed.length === 0 && <p className="text-[0.8125rem] text-t3">No chat is running now.</p>}
        {listed.map((id) => (
          <label key={id} className="flex min-h-11 items-center gap-2 text-[0.8125rem] text-t1">
            <input
              type="checkbox"
              className="size-4"
              checked={chats.includes(id)}
              onChange={(event) =>
                setChats((now) =>
                  event.target.checked ? [...now, id] : now.filter((each) => each !== id),
                )
              }
            />
            {chatName(id, running)}
          </label>
        ))}
      </fieldset>
      {problem !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          Save rule
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The usage rules: each with its conditions and chats, on or off, to edit or remove; and a new one. */
function RulesSection({
  client,
  running,
  rules,
  problem,
  reload,
}: {
  readonly client: AppClient;
  readonly running: readonly RunningChat[];
  readonly rules: UsageRulesResult | null;
  readonly problem: string | null;
  readonly reload: () => void;
}): ReactNode {
  const [editing, setEditing] = useState<UsageRule | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const session = client.port(ChatSessionPort);
  const save = async (rule: UsageRule): Promise<void> => {
    await session.setUsageRule(rule);
    setEditing(null);
    reload();
  };
  const act = (work: Promise<unknown>): void => {
    work
      .then(reload)
      .catch((caught: unknown) => setFailure(problemWords("Changing rules", caught)));
  };
  if (problem !== null) return <p className="text-[0.8125rem] text-t3">{problem}</p>;
  if (rules === null) return <p className="text-[0.8125rem] text-t3">Reading…</p>;
  return (
    <div className="flex flex-col gap-2">
      {rules.rules.length === 0 && editing === null && (
        <p className="text-[0.8125rem] text-t3">
          No rules yet. A rule pauses the chats you pick while a condition holds: a window's use,
          the pace, or the hours of the day.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {rules.rules.map(({ rule, held }) =>
          editing?.id === rule.id ? (
            <li key={rule.id}>
              <RuleEditor
                rule={editing}
                running={running}
                onSave={save}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <li
              key={rule.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-l2 px-3 py-2"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[0.8125rem] font-medium text-t1">{rule.name}</span>
                <span className="text-xs text-t3">{conditionWords(rule)}</span>
                <span className="text-xs text-t3">
                  {rule.chats.length === 1 ? "1 chat" : `${rule.chats.length} chats`}
                  {held.length > 0 ? ` · holding ${held.length} now` : ""}
                </span>
              </div>
              <Switch
                aria-label={`${rule.name} on`}
                checked={rule.enabled}
                onCheckedChange={(enabled) => act(session.setUsageRule({ ...rule, enabled }))}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Edit ${rule.name}`}
                onClick={() => setEditing(rule)}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${rule.name}`}
                onClick={() => act(session.removeUsageRule({ id: rule.id }))}
              >
                <Trash2 />
              </Button>
            </li>
          ),
        )}
      </ul>
      {editing !== null && !rules.rules.some(({ rule }) => rule.id === editing.id) ? (
        <RuleEditor
          rule={editing}
          running={running}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      ) : (
        editing === null && (
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => setEditing({ id: crypto.randomUUID(), ...NEW_RULE })}
          >
            <Plus />
            New rule
          </Button>
        )
      )}
      <p className="text-xs text-t3">Hours are the server's time ({rules.timeZone}).</p>
      {failure !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {failure}
        </p>
      )}
    </div>
  );
}

/** The held chats in the order they continue: why each waits, when it continues, and the reader's say over it. */
function QueueSection({
  client,
  running,
  queue,
  rules,
  problem,
  reload,
}: {
  readonly client: AppClient;
  readonly running: readonly RunningChat[];
  readonly queue: UsageQueueResult | null;
  readonly rules: readonly UsageRule[];
  readonly problem: string | null;
  readonly reload: () => void;
}): ReactNode {
  const [failure, setFailure] = useState<string | null>(null);
  const session = client.port(ChatSessionPort);
  const act = (work: Promise<unknown>): void => {
    work
      .then(reload)
      .catch((caught: unknown) => setFailure(problemWords("Changing the queue", caught)));
  };
  if (problem !== null) return <p className="text-[0.8125rem] text-t3">{problem}</p>;
  if (queue === null) return <p className="text-[0.8125rem] text-t3">Reading…</p>;
  if (queue.chats.length === 0)
    return (
      <p className="text-[0.8125rem] text-t3">
        No chat is held: every chat a rule lists runs as you left it.
      </p>
    );
  const now = Date.now();
  const ids = queue.chats.map((chat) => chat.id);
  const move = (index: number, by: -1 | 1): void => {
    const order = [...ids];
    const [taken] = order.splice(index, 1);
    if (taken === undefined) return;
    order.splice(index + by, 0, taken);
    act(session.orderUsageQueue({ threadIds: order }));
  };
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2">
        {queue.chats.map((chat, index) => {
          const name = chatName(chat.id, running);
          return (
            <li
              key={chat.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-l2 px-3 py-2"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[0.8125rem] font-medium text-t1">{name}</span>
                <span className="text-xs text-t3">{holdWords(chat.hold, rules, now)}</span>
                {chat.continuesAt !== null && (
                  <span className="text-xs text-t2">
                    Continues at {whenWords(chat.continuesAt, now)}
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Move ${name} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Move ${name} down`}
                disabled={index === queue.chats.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => act(session.continueHeld({ threadId: chat.id }))}
              >
                Continue now
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => act(session.skipHeld({ threadId: chat.id }))}
              >
                Skip
              </Button>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-t3">
        Chats continue in this order, one at a time, three minutes apart. Skip leaves a chat paused
        for you to resume.
      </p>
      {failure !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {failure}
        </p>
      )}
    </div>
  );
}

/** The rules and the queue, read together, again every 30 seconds and whenever the running chats change. */
function useRulesAndQueue(client: AppClient, running: readonly RunningChat[]) {
  const [rules, setRules] = useState<UsageRulesResult | null>(null);
  const [queue, setQueue] = useState<UsageQueueResult | null>(null);
  const [rulesProblem, setRulesProblem] = useState<string | null>(null);
  const [queueProblem, setQueueProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const reload = useCallback(() => setRound((value) => value + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new round, or a change of the running chats, reads again
  useEffect(() => {
    let alive = true;
    const session = client.port(ChatSessionPort);
    session
      .usageRules({})
      .then((found) => {
        if (!alive) return;
        setRules(found);
        setRulesProblem(null);
      })
      .catch((failure: unknown) => alive && setRulesProblem(problemWords("Rules", failure)));
    session
      .usageQueue({})
      .then((found) => {
        if (!alive) return;
        setQueue(found);
        setQueueProblem(null);
      })
      .catch((failure: unknown) => alive && setQueueProblem(problemWords("The queue", failure)));
    const timer = setTimeout(reload, READ_EVERY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [client, round, running, reload]);
  return { rules, queue, rulesProblem, queueProblem, reload };
}

function DashboardSheet({
  client,
  phone,
  onClose,
}: {
  readonly client: AppClient;
  readonly phone: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const running = useRunningChats(client);
  const { rules, queue, rulesProblem, queueProblem, reload } = useRulesAndQueue(client, running);
  return (
    <DialogContent
      data-tour="dashboard"
      showCloseButton={!phone}
      className={
        phone
          ? "top-0 left-0 flex h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 pt-(--safe-top) pr-(--safe-right) pb-(--safe-bottom) pl-(--safe-left) ring-0 sm:max-w-none"
          : "flex h-[min(820px,94dvh)] w-[min(760px,calc(96vw-var(--safe-left)-var(--safe-right)))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      }
    >
      <header className="flex min-h-11 shrink-0 items-center gap-1 border-b border-l2 px-2 py-1 pr-12">
        {phone && (
          <Button variant="ghost" className="h-11 shrink-0 text-t2" onClick={onClose}>
            <ChevronLeft />
            Chats
          </Button>
        )}
        <DialogTitle className={phone ? "text-base" : "px-2 text-base"}>Dashboard</DialogTitle>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <Section title="Usage windows" hint="Your accounts' windows as omp reports them.">
          <AccountsSection client={client} />
        </Section>
        <Section title="Pace" hint="From the server's readings of the last hour.">
          <PaceSection client={client} />
        </Section>
        <Section
          title="Rules"
          hint="Pause chats while a condition holds, and continue them once none does."
        >
          <RulesSection
            client={client}
            running={running}
            rules={rules}
            problem={rulesProblem}
            reload={reload}
          />
        </Section>
        <Section title="Queue" hint="The chats the rules hold, in the order they continue.">
          <QueueSection
            client={client}
            running={running}
            queue={queue}
            rules={rules?.rules.map(({ rule }) => rule) ?? []}
            problem={queueProblem}
            reload={reload}
          />
        </Section>
      </div>
    </DialogContent>
  );
}

/**
 * The dashboard (#2836): the accounts' usage windows and their pace, the rules that pause and continue chats on
 * conditions, and the queue of the chats they hold. A page of its own, as the settings are: the whole screen on a phone.
 */
export function DashboardPage({
  client,
  phone,
  open,
  onOpenChange,
}: {
  readonly client: AppClient;
  readonly phone: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <DashboardSheet client={client} phone={phone} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}
