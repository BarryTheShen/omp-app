import { Popover } from "@base-ui/react/popover";
import { AppFailure, type UsageLimitsResult } from "@omp-app/contracts";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { UsageLimitsSource, UsagePort, UsageTotals } from "../contract";
import { LimitBar } from "./limit-bar";

function useUsageSnapshot(port: UsagePort) {
  const subscribe = useCallback(
    (listener: Parameters<UsagePort["subscribe"]>[0]) => port.subscribe(listener),
    [port],
  );
  const getSnapshot = useCallback(() => port.getSnapshot(), [port]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function number(value: number): string {
  return value.toLocaleString();
}

const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function money(value: number): string {
  return value > 0 && value < 0.005 ? "<$0.01" : currency.format(value);
}

function cacheHitRate(totals: UsageTotals): number | null {
  const denominator = totals.cacheRead + totals.cacheWrite + totals.input;
  return denominator === 0 ? null : totals.cacheRead / denominator;
}

function UsageTotalsTable({
  title,
  totals,
}: {
  readonly title: string;
  readonly totals: UsageTotals;
}) {
  const hitRate = cacheHitRate(totals);
  return (
    <section
      aria-labelledby={`${title.toLowerCase().replaceAll(" ", "-")}-usage-title`}
      className="border-foreground/10 border-b pb-3 last:border-b-0 last:pb-0"
    >
      <h3
        id={`${title.toLowerCase().replaceAll(" ", "-")}-usage-title`}
        className="text-sm font-medium text-muted-foreground"
      >
        {title}
      </h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Input</dt>
          <dd>{number(totals.input)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Output</dt>
          <dd>{number(totals.output)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Cache read</dt>
          <dd>{number(totals.cacheRead)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Cache write</dt>
          <dd>{number(totals.cacheWrite)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Total</dt>
          <dd>{number(totals.totalTokens)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Cost</dt>
          <dd>{money(totals.cost)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Cache hit</dt>
          <dd>{hitRate === null ? "—" : `${Math.round(hitRate * 100)}%`}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Premium requests</dt>
          <dd>{totals.premiumRequests === null ? "—" : number(totals.premiumRequests)}</dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * omp's provider limits for the signed-in accounts: each window's share used and when it resets. It reads when it
 * mounts; the popover remounts it on Refresh, and says why when omp's limits cannot be read.
 */
function ProviderLimitsSection({ limits }: { readonly limits: UsageLimitsSource }) {
  const [result, setResult] = useState<UsageLimitsResult | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void limits.read().then((next) => {
      if (active) setResult(next);
    });
    return () => {
      active = false;
    };
  }, [limits]);
  const now = new Date();
  return (
    <section
      aria-labelledby="provider-limits-title"
      className="border-foreground/10 border-b pb-3 last:border-b-0 last:pb-0"
    >
      <h3 id="provider-limits-title" className="text-sm font-medium text-muted-foreground">
        Provider limits
      </h3>
      {result === undefined ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Reading provider limits…
        </p>
      ) : null}
      {result?.state === "unavailable" ? (
        <p className="mt-2 text-sm text-muted-foreground">{result.reason}</p>
      ) : null}
      {result?.state === "ready" && result.providers.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          omp reports no usage limits for your signed-in accounts.
        </p>
      ) : null}
      {result?.state === "ready" && result.providers.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2 text-sm">
          {result.providers.map((provider) => (
            <li key={provider.providerId}>
              <p className="font-medium">{provider.providerId}</p>
              <ul className="mt-2 flex flex-col gap-3">
                {provider.windows.map((window) => (
                  <li key={window.label}>
                    <LimitBar now={now} providerId={provider.providerId} window={window} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function UsagePopover({
  port,
  limits,
}: {
  readonly port: UsagePort;
  readonly limits: UsageLimitsSource;
}) {
  const snapshot = useUsageSnapshot(port);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [limitsKey, setLimitsKey] = useState(0);
  // The session's totals come from omp's `get_session_stats` (see `createUsagePort`): omp streams none, so they are read
  // each time the panel opens, not only on Refresh (issue 2651). A failed read says why, in place of an empty section.
  const readSession = useCallback(async () => {
    setBusy(true);
    setReadError(null);
    try {
      await port.refresh();
    } catch (cause) {
      setReadError(
        cause instanceof AppFailure ? cause.appError.message : "Loading session usage failed.",
      );
    } finally {
      setBusy(false);
    }
  }, [port]);
  const refresh = async () => {
    await readSession();
    setLimitsKey((key) => key + 1);
  };
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) void readSession();
      }}
    >
      <Popover.Trigger
        render={
          <Button
            className="border-0 text-muted-foreground hover:text-foreground rounded-control h-7 px-2 text-xs font-normal transition-colors"
            type="button"
            variant="ghost"
            size="xs"
          />
        }
      >
        Usage
        {snapshot.totals ? (
          <span className="text-muted-foreground text-meta">
            {number(snapshot.totals.totalTokens)} tokens
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        {/* Above the transcript footer, which would otherwise cover the header of this popup. */}
        <Popover.Positioner sideOffset={8} align="end" className="z-50">
          <Popover.Popup
            role="dialog"
            aria-label="Session usage details"
            className="bg-popover text-popover-foreground flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-surface border border-foreground/10 p-4 shadow-none outline-none"
          >
            <header className="flex items-center justify-between gap-2">
              <div>
                <Popover.Title className="text-sm font-medium">Usage</Popover.Title>
                <Popover.Description className="text-sm text-muted-foreground">
                  Current session
                </Popover.Description>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void refresh()}
              >
                Refresh
              </Button>
            </header>
            {snapshot.status === "loading" ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading usage…
              </p>
            ) : null}
            {snapshot.status === "error" ? (
              <p role="alert" className="text-sm text-destructive">
                {snapshot.error?.message ?? "Usage unavailable."}
              </p>
            ) : null}
            {readError !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {readError}
              </p>
            ) : null}
            {!snapshot.totals && busy && snapshot.status !== "loading" ? (
              <p role="status" className="text-sm text-muted-foreground">
                Reading this chat's usage…
              </p>
            ) : null}
            {snapshot.totals ? <UsageTotalsTable title="Session" totals={snapshot.totals} /> : null}
            {snapshot.lastTurn ? (
              <UsageTotalsTable title="Last turn" totals={snapshot.lastTurn.usage} />
            ) : null}
            <ProviderLimitsSection key={limitsKey} limits={limits} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
