import { Popover } from "@base-ui/react/popover";
import { useCallback, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { UsagePort, UsageTotals } from "../contract";

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
      className="border-border/60 border-b pb-3 last:border-b-0 last:pb-0"
    >
      <h3
        id={`${title.toLowerCase().replaceAll(" ", "-")}-usage-title`}
        className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
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

export function UsagePopover({ port }: { readonly port: UsagePort }) {
  const snapshot = useUsageSnapshot(port);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      await port.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button type="button" variant="outline" size="sm" />}>
        Usage
        {snapshot.totals ? (
          <span className="text-muted-foreground">
            {number(snapshot.totals.totalTokens)} tokens
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end">
          <Popover.Popup
            role="dialog"
            aria-label="Session usage details"
            className="bg-popover text-popover-foreground flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl border border-border p-4 shadow-lg outline-none"
          >
            <header className="flex items-center justify-between gap-2">
              <div>
                <Popover.Title className="font-semibold">Usage</Popover.Title>
                <Popover.Description className="text-xs text-muted-foreground">
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
            {snapshot.totals ? <UsageTotalsTable title="Session" totals={snapshot.totals} /> : null}
            {snapshot.lastTurn ? (
              <UsageTotalsTable title="Last turn" totals={snapshot.lastTurn.usage} />
            ) : null}
            <p className="text-xs text-muted-foreground">
              Provider quota is unavailable from this host.
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
