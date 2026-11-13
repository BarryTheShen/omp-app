import type { AppClient } from "@omp-app/client";
import { AppPort, type OmpUpdates } from "@omp-app/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** "Nov 13": the day a night's run began, in this browser's time. */
const dayOf = (at: string): string =>
  new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * Settings → App → omp: the omp release the app runs; and where a job beside the app updates omp at night (one that
 * writes `<app data>/omp-update.json`), automatic updates on or off, what its last run came to, a new omp ready to
 * move to, and why updates stopped, when they did.
 */
export function OmpSection({ client }: { readonly client: AppClient }): ReactNode {
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  const [updates, setUpdates] = useState<OmpUpdates | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const app = client.port(AppPort);
    app.serverInfo({}).then(
      (info) => alive && setVersion(info.omp?.version ?? null),
      () => undefined,
    );
    app.ompUpdates({}).then(
      (next) => alive && setUpdates(next),
      (failure: unknown) =>
        alive && setProblem(`What the omp updates last did could not be read: ${words(failure)}`),
    );
    return () => {
      alive = false;
    };
  }, [client]);
  const turn = (enabled: boolean): void => {
    setSaving(true);
    setProblem(null);
    client
      .port(AppPort)
      .setOmpUpdates({ enabled })
      .then(
        (next) => setUpdates(next),
        (failure: unknown) => setProblem(`The switch was not saved: ${words(failure)}`),
      )
      .finally(() => setSaving(false));
  };
  const job = updates?.job ?? null;
  return (
    <section aria-label="omp" data-tour="omp-updates">
      <h3 className="mt-6 text-xs font-medium text-t3">omp</h3>
      <p className="mt-2 text-sm text-t2">
        {version === undefined
          ? "\u00a0"
          : version === null
            ? "This server found no omp to run."
            : `Your chats run on omp ${version}.`}
      </p>
      {updates !== null && job !== null && (
        <>
          <div className="flex items-center gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-t1">Automatic updates</p>
              <p className="mt-0.5 text-xs text-t3">
                Every third night a newer omp is tested on its own. When it passes, the app moves to
                it between 3 and 5 a.m., with every chat paused across the move.
              </p>
            </div>
            <Switch
              aria-label="Automatic omp updates"
              checked={updates.enabled}
              disabled={saving}
              onCheckedChange={turn}
            />
          </div>
          <p className="text-xs text-t3">
            Last run, {dayOf(job.lastNight.at)}: {job.lastNight.result}
          </p>
          {job.pending !== undefined && (
            <p className="mt-1 text-xs text-t2">
              {updates.enabled
                ? `omp ${job.pending} is ready: the app moves to it between 3 and 5 a.m.`
                : `omp ${job.pending} is ready, and waits until automatic updates are on.`}
            </p>
          )}
          {job.blocked !== undefined && (
            <p role="alert" className="mt-1 text-xs text-bad-ink">
              Updates stopped until someone looks: {job.blocked}
            </p>
          )}
        </>
      )}
      {problem !== null && (
        <p role="alert" className="mt-2 text-sm text-bad-ink">
          {problem}
        </p>
      )}
    </section>
  );
}
