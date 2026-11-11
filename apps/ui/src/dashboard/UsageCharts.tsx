import type { AppClient } from "@omp-app/client";
import { type RunningChat, type UsageHistoryResult, UsageLimitStore } from "@omp-app/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { follow } from "../follow";
import { partWords, spendWords } from "../panels/usage/usage-words";
import { useShares } from "./ChatsSection";
import { seriesColor } from "./palette";

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** Each window's readings over the day, read once and again at each fresh reading of the limits. */
function useHistory(client: AppClient): UsageHistoryResult | null {
  const [history, setHistory] = useState<UsageHistoryResult | null>(null);
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      client
        .port(UsageLimitStore)
        .history({})
        .then(
          (found) => alive && setHistory(found),
          () => undefined,
        );
    };
    read();
    const stop = follow(client.subscribe(UsageLimitStore, "changed"), read);
    return () => {
      alive = false;
      stop();
    };
  }, [client]);
  return history;
}

/**
 * Each window's use over the last day (#15), from the server's readings: one line a window, its percent at each
 * reading, so a climb, a reset and the pace show at a glance.
 */
export function WindowsOverTheDay({ client }: { readonly client: AppClient }): ReactNode {
  const history = useHistory(client);
  if (history === null) return <p className="text-[0.8125rem] text-t3">Reading…</p>;
  const windows = history.windows.filter((window) => window.readings.length >= 2);
  if (windows.length === 0) {
    return (
      <p className="text-[0.8125rem] text-t3">
        Not enough readings yet: the server reads your accounts every 5 minutes, every minute near a
        limit.
      </p>
    );
  }
  const keys = windows.map((_, index) => `w${index}`);
  const config: ChartConfig = Object.fromEntries(
    windows.map((window, index) => [
      keys[index],
      { label: `${window.providerId} · ${window.label}`, color: seriesColor(index) },
    ]),
  );
  // One row per reading time, each window's percent at it where it was read.
  const rows = new Map<number, Record<string, number>>();
  windows.forEach((window, index) => {
    for (const [at, used] of window.readings) {
      const row = rows.get(at) ?? { at };
      row[keys[index] ?? ""] = Math.round(used * 10) / 10;
      rows.set(at, row);
    }
  });
  const data = [...rows.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return (
    <ChartContainer
      config={config}
      className="aspect-auto h-56 w-full"
      role="img"
      aria-label={`Each window's use over the last day: ${windows
        .map(
          (window) =>
            `${window.providerId} ${window.label} now ${Math.round(window.readings.at(-1)?.[1] ?? 0)}%`,
        )
        .join(", ")}`}
    >
      <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--l2)" />
        <XAxis
          dataKey="at"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(at: number) => clock.format(at)}
          tickLine={false}
          axisLine={false}
          minTickGap={40}
        />
        <YAxis
          domain={[0, 100]}
          ticks={[0, 25, 50, 75, 100]}
          tickFormatter={(value: number) => `${value}%`}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const at = payload?.[0]?.payload?.at;
                return typeof at === "number" ? clock.format(at) : "";
              }}
              formatter={(value, name) => (
                <span className="flex w-full justify-between gap-3">
                  <span className="text-t2">{config[String(name)]?.label}</span>
                  <span className="text-t1 tabular-nums">{String(value)}%</span>
                </span>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {keys.map((key) => (
          <Line
            key={key}
            dataKey={key}
            type="monotone"
            stroke={`var(--color-${key})`}
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

/**
 * Each provider's 5-hour window split among the chats that used it (#14, #15): a bar of the window's use, a colour a
 * chat, the part outside the app grey; under it each chat's part and spend, the largest first.
 */
export function ChatParts({
  client,
  running,
}: {
  readonly client: AppClient;
  readonly running: readonly RunningChat[];
}): ReactNode {
  const shares = useShares(client);
  if (shares === null) return <p className="text-[0.8125rem] text-t3">Reading…</p>;
  if (shares.providers.length === 0) {
    return (
      <p className="text-[0.8125rem] text-t3">
        Each chat's part shows from the next reading of your accounts.
      </p>
    );
  }
  const nameOf = (threadId: string): string =>
    running.find((chat) => chat.threadId === threadId)?.title ?? `A chat (${threadId.slice(0, 8)})`;
  return (
    <div className="flex flex-col gap-4">
      {shares.providers.map((provider) => {
        const chats = provider.chats.filter((chat) => chat.share > 0 || chat.cost > 0).slice(0, 8);
        const total = Math.max(100, provider.used);
        return (
          <section
            key={provider.providerId}
            aria-label={`${provider.providerId}'s 5-hour window by chat`}
            className="flex flex-col gap-1.5"
          >
            <p className="text-[0.8125rem] text-t1">
              {provider.providerId} ·{" "}
              <span className="text-t2 tabular-nums">{Math.round(provider.used)}% used</span>
            </p>
            <div
              role="img"
              aria-label={`${chats.map((chat) => `${nameOf(chat.threadId)} ${partWords(chat.share)}`).join(", ")}${chats.length > 0 ? ", " : ""}outside the app ${partWords(provider.outside)}`}
              className="flex h-3 w-full overflow-hidden rounded-full bg-l2"
            >
              {chats.map((chat, index) => (
                <span
                  key={chat.threadId}
                  className="h-full"
                  style={{
                    width: `${(chat.share / total) * 100}%`,
                    background: seriesColor(index),
                  }}
                />
              ))}
              <span
                className="h-full bg-t4"
                style={{ width: `${(provider.outside / total) * 100}%` }}
              />
            </div>
            <ul className="flex flex-col gap-0.5 text-xs">
              {chats.map((chat, index) => (
                <li key={chat.threadId} className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-sm"
                    style={{ background: seriesColor(index) }}
                  />
                  <span className="min-w-0 flex-1 truncate text-t1">{nameOf(chat.threadId)}</span>
                  <span className="text-t2 tabular-nums">{partWords(chat.share)}</span>
                  <span className="w-16 text-right text-t3 tabular-nums">
                    {spendWords(chat.cost)}
                  </span>
                </li>
              ))}
              <li className="flex items-center gap-2">
                <span aria-hidden className="size-2 shrink-0 rounded-sm bg-t4" />
                <span className="min-w-0 flex-1 truncate text-t3">
                  Outside the app, or before {clock.format(provider.since)}
                </span>
                <span className="text-t3 tabular-nums">{partWords(provider.outside)}</span>
                <span className="w-16" />
              </li>
            </ul>
          </section>
        );
      })}
      <p className="text-xs text-pretty text-t3">
        An estimate: each reading's growth goes to the chats by what each spent since the last.
      </p>
    </div>
  );
}
