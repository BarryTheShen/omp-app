import type { AppClient } from "@omp-app/client";
import {
  type RunningChat,
  StatsPort,
  type StatsRange,
  type StatsSummary,
  UsageLimitStore,
  type UsageLimitsResult,
} from "@omp-app/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { PolarAngleAxis, RadialBar, RadialBarChart } from "recharts";
import { ChartContainer } from "@/components/ui/chart";
import { follow } from "../follow";
import { combinedShare, limitTone, resetsInWords } from "../panels/usage/usage-words";
import { STATE_DOT, toneColor } from "./palette";

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US");
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

const requestWords = (count: number): string =>
  count === 1 ? "1 request" : `${whole.format(count)} requests`;

/** omp's statistics for `range`, read once the dashboard shows (its first read can take omp a minute). */
function useStats(client: AppClient, range: StatsRange): StatsSummary | null {
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  useEffect(() => {
    let alive = true;
    client
      .port(StatsPort)
      .summary({ range })
      .then(
        (read) => alive && setSummary(read),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [client, range]);
  return summary;
}

/** The accounts' windows, read once and again at each fresh read the server sends. */
function useLimits(client: AppClient): UsageLimitsResult | null {
  const [limits, setLimits] = useState<UsageLimitsResult | null>(null);
  useEffect(() => {
    let alive = true;
    const show = (read: UsageLimitsResult): void => {
      if (alive) setLimits(read);
    };
    const stop = follow(client.subscribe(UsageLimitStore, "changed"), show);
    client
      .port(UsageLimitStore)
      .read({})
      .then(show, () => undefined);
    return () => {
      alive = false;
      stop();
    };
  }, [client]);
  return limits;
}

type Tone = "accent" | "warn" | "bad" | "plain";
const TONE_TEXT: Record<Tone, string> = {
  accent: "text-accent-ink",
  warn: "text-warn-ink",
  bad: "text-bad-ink",
  plain: "text-t1",
};

/** One figure of the overview: its name, its value in its colour, and a line under it. */
function Tile({
  name,
  value,
  note,
  tone = "plain",
}: {
  readonly name: string;
  readonly value: string;
  readonly note?: ReactNode;
  readonly tone?: Tone;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-l2 bg-panel px-3 py-2.5">
      <span className="text-xs text-t3">{name}</span>
      <span className={`truncate text-xl font-medium tabular-nums ${TONE_TEXT[tone]}`}>
        {value}
      </span>
      {note !== undefined && <span className="truncate text-xs text-t3">{note}</span>}
    </div>
  );
}

/** One window as a half ring coloured by how full it is, its percent in the middle. */
function Gauge({
  provider,
  label,
  used,
  note,
}: {
  readonly provider: string;
  readonly label: string;
  readonly used: number;
  readonly note: string;
}): ReactNode {
  const shown = Math.max(0, Math.min(100, used));
  const color = toneColor(limitTone(used));
  return (
    <div
      role="img"
      aria-label={`${provider}, ${label}: ${Math.round(used)}% used, ${note}`}
      className="flex min-w-0 flex-col items-center rounded-lg border border-l2 bg-panel px-3 pt-2 pb-2.5"
    >
      <div className="relative h-20 w-36">
        <ChartContainer
          config={{ used: { label, color } }}
          className="absolute inset-0 aspect-auto"
        >
          <RadialBarChart
            data={[{ used: shown }]}
            startAngle={180}
            endAngle={0}
            innerRadius="140%"
            outerRadius="190%"
            cy="100%"
          >
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
            <RadialBar
              dataKey="used"
              fill={color}
              background={{ fill: "var(--l2)" }}
              cornerRadius={6}
              isAnimationActive={false}
            />
          </RadialBarChart>
        </ChartContainer>
        <span className="absolute inset-x-0 bottom-0 text-center text-lg font-medium text-t1 tabular-nums">
          {Math.round(used)}%
        </span>
      </div>
      <span className="mt-1 max-w-full truncate text-xs text-t1">
        {provider} · {label}
      </span>
      <span className="max-w-full truncate text-xs text-t3">{note}</span>
    </div>
  );
}

/**
 * The dashboard's overview (#15): what was spent and used today and this week, the running chats by what they do, and
 * each provider's windows as half rings coloured by how full they are.
 */
export function Overview({
  client,
  running,
}: {
  readonly client: AppClient;
  readonly running: readonly RunningChat[];
}): ReactNode {
  const today = useStats(client, "24h");
  const week = useStats(client, "7d");
  const limits = useLimits(client);
  const now = new Date();
  const counts = {
    working: running.filter((chat) => chat.state === "working").length,
    waiting: running.filter((chat) => chat.state === "waiting").length,
    paused: running.filter((chat) => chat.state === "paused").length,
    idle: running.filter((chat) => chat.state === "idle").length,
  };
  const failed = today?.totals.errorRate ?? 0;
  const gauges =
    limits?.state === "ready"
      ? limits.providers.flatMap((provider) =>
          provider.windows.map((window) => ({
            key: `${provider.providerId}\u0000${window.label}`,
            provider: provider.providerId,
            label: window.label,
            used: combinedShare(window)?.percent ?? window.usedPercent,
            note: resetsInWords(window.resetsAt, now),
          })),
        )
      : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3 @5xl:grid-cols-5">
        <Tile
          name="Spent in 24 hours"
          value={today === null ? "…" : dollars.format(today.totals.cost)}
          note={today === null ? "Reading omp's statistics" : requestWords(today.totals.requests)}
          tone="accent"
        />
        <Tile
          name="Spent in 7 days"
          value={week === null ? "…" : dollars.format(week.totals.cost)}
          note={week === null ? "" : requestWords(week.totals.requests)}
        />
        <Tile
          name="Tokens in 24 hours"
          value={
            today === null
              ? "…"
              : compact.format(
                  today.totals.inputTokens +
                    today.totals.cacheReadTokens +
                    today.totals.outputTokens,
                )
          }
          note={today === null ? "" : `${percent.format(today.totals.cacheRate)} from the cache`}
        />
        <Tile
          name="Failed in 24 hours"
          value={today === null ? "…" : percent.format(failed)}
          note={
            today === null
              ? ""
              : `${whole.format(today.totals.failed)} of ${requestWords(today.totals.requests)}`
          }
          tone={failed >= 0.05 ? "bad" : failed > 0 ? "warn" : "plain"}
        />
        <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-l2 bg-panel px-3 py-2.5">
          <span className="text-xs text-t3">Chats running</span>
          <span className="text-xl font-medium text-t1 tabular-nums">{running.length}</span>
          <ul
            aria-label="Chats by what they do"
            className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-t2"
          >
            {(
              [
                ["working", "working"],
                ["waiting", "wait for you"],
                ["paused", "paused"],
                ["idle", "idle"],
              ] as const
            ).map(([state, words]) => (
              <li key={state} className="flex items-center gap-1.5">
                <span aria-hidden className={`size-1.5 rounded-full ${STATE_DOT[state]}`} />
                {counts[state]} {words}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {gauges.length > 0 && (
        <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4 @5xl:grid-cols-6">
          {gauges.map(({ key, ...gauge }) => (
            <Gauge key={key} {...gauge} />
          ))}
        </div>
      )}
    </div>
  );
}
