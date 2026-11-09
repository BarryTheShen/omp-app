import type { AppClient } from "@omp-app/client";
import { StatsPort, type StatsRange, type StatsSummary } from "@omp-app/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { problemWords } from "./problems";

const LATER = "omp's statistics in brief come with the next server update.";

const RANGES: readonly { readonly id: StatsRange; readonly label: string; readonly per: string }[] =
  [
    { id: "24h", label: "24 hours", per: "hour" },
    { id: "7d", label: "7 days", per: "day" },
    { id: "30d", label: "30 days", per: "day" },
  ];

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US");
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

/** A cost as words: "$12.34", and "under $0.01" for a cost too small to show. */
function costWords(cost: number): string {
  return cost > 0 && cost < 0.005 ? "under $0.01" : dollars.format(cost);
}

/** Milliseconds as "1.4 s" or "850 ms"; "none" with no request. */
function durationWords(ms: number | null): string {
  if (ms === null) return "none";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** A bucket's start as the chart names it: the hour for 24 hours, else the day. */
function bucketWords(at: number, range: StatsRange): string {
  return range === "24h"
    ? new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : new Date(at).toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
      });
}

/** The summary for a range, read when the section first shows, and again for each range picked. */
function useStatsSummary(client: AppClient, range: StatsRange, shown: boolean) {
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!shown) return;
    let active = true;
    setReading(true);
    setProblem(null);
    client
      .port(StatsPort)
      .summary({ range })
      .then(
        (read) => active && setSummary(read),
        (failure: unknown) =>
          active && setProblem(problemWords(failure, LATER, "read omp's statistics")),
      )
      .finally(() => active && setReading(false));
    return () => {
      active = false;
    };
  }, [client, range, shown]);
  return { summary, reading, problem };
}

/** One number of the totals: its name above, its value below. */
function Figure({ name, value }: { readonly name: string; readonly value: string }): ReactNode {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-t3">{name}</dt>
      <dd className="truncate text-base font-medium text-t1 tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * omp's statistics in brief (`/stats`, D7): for 24 hours, 7 days or 30 days, the requests, cost, tokens, cache and
 * errors, the cost of each hour or day, and the models that cost the most; read from omp's own statistics page when
 * the section first shows (its first start reads every chat, up to a minute).
 */
export function StatsSummaryView({ client }: { readonly client: AppClient }): ReactNode {
  const [range, setRange] = useState<StatsRange>("7d");
  const [shown, setShown] = useState(false);
  const place = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = place.current;
    if (element === null || shown) return;
    const watch = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setShown(true);
    });
    watch.observe(element);
    return () => watch.disconnect();
  }, [shown]);
  const { summary, reading, problem } = useStatsSummary(client, range, shown);
  const chosen = RANGES.find((each) => each.id === range) ?? {
    id: range,
    label: range,
    per: "day",
  };
  const shownSummary = summary?.range === range ? summary : null;
  const highest = Math.max(0, ...(shownSummary?.buckets ?? []).map((bucket) => bucket.cost));
  const peak = shownSummary?.buckets.find((bucket) => bucket.cost === highest);

  return (
    <div ref={place} className="flex flex-col gap-3">
      <ToggleGroup
        aria-label="Over the last"
        size="sm"
        spacing={0.5}
        className="self-start rounded-lg border border-l2 p-0.5"
        value={[range]}
        onValueChange={(next: string[]) => {
          if (next[0] !== undefined) setRange(next[0] as StatsRange);
        }}
      >
        {RANGES.map((each) => (
          <ToggleGroupItem
            key={each.id}
            value={each.id}
            className="h-6 px-2 text-xs text-t3 aria-pressed:bg-l2 aria-pressed:text-t1 max-sm:h-11 tablet:h-11"
          >
            {each.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {problem !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {problem}
        </p>
      )}
      {shownSummary === null && problem === null && (
        <p className="text-sm text-t3">
          {reading || !shown
            ? "Reading omp's statistics… The first time, omp reads every chat: it can take a minute."
            : "No statistics yet."}
        </p>
      )}
      {shownSummary !== null && (
        <>
          <dl aria-label="Totals" className="grid grid-cols-2 gap-x-4 gap-y-2 @md:grid-cols-3">
            <Figure name="Requests" value={whole.format(shownSummary.totals.requests)} />
            <Figure name="Cost" value={costWords(shownSummary.totals.cost)} />
            <Figure
              name="Tokens in / out"
              value={`${compact.format(shownSummary.totals.inputTokens + shownSummary.totals.cacheReadTokens)} / ${compact.format(shownSummary.totals.outputTokens)}`}
            />
            <Figure
              name="Read from the cache"
              value={percent.format(shownSummary.totals.cacheRate)}
            />
            <Figure name="Failed" value={percent.format(shownSummary.totals.errorRate)} />
            <Figure
              name="A reply takes"
              value={durationWords(shownSummary.totals.averageDuration)}
            />
          </dl>
          {shownSummary.buckets.length > 0 && (
            <div className="flex flex-col gap-1">
              <div
                role="img"
                aria-label={
                  peak === undefined || highest === 0
                    ? `Cost per ${chosen.per}: nothing spent`
                    : `Cost per ${chosen.per} over the last ${chosen.label}; the most, ${costWords(highest)}, ${bucketWords(peak.at, range)}`
                }
                className="flex h-24 items-end gap-px rounded-md border border-l2 p-1"
              >
                {shownSummary.buckets.map((bucket) => (
                  <div
                    key={bucket.at}
                    title={`${bucketWords(bucket.at, range)}: ${costWords(bucket.cost)}, ${whole.format(bucket.requests)} requests`}
                    className="min-w-px flex-1 rounded-t-sm bg-accent/70"
                    style={{
                      height: `${highest === 0 ? 0 : Math.max(2, (bucket.cost / highest) * 100)}%`,
                    }}
                  />
                ))}
              </div>
              <p className="text-xs text-t3">Cost per {chosen.per}.</p>
            </div>
          )}
          {shownSummary.models.length > 0 && (
            <table aria-label="Models by cost" className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-t3">
                  <th className="pb-1 font-normal">Model</th>
                  <th className="pb-1 text-right font-normal">Requests</th>
                  <th className="pb-1 text-right font-normal">Cost</th>
                </tr>
              </thead>
              <tbody>
                {shownSummary.models.map((model) => (
                  <tr key={`${model.provider}/${model.model}`} className="border-t border-l2">
                    <td
                      className="max-w-0 truncate py-1 pr-2 text-t1"
                      title={`${model.provider}/${model.model}`}
                    >
                      {model.model}
                    </td>
                    <td className="py-1 text-right text-t2 tabular-nums">
                      {whole.format(model.requests)}
                    </td>
                    <td className="py-1 text-right text-t1 tabular-nums">
                      {costWords(model.cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
