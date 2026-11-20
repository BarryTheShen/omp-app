import type { AppClient } from "@omp-app/client";
import { APP_RELEASES, AppPort, type AppUpdates, isNewerRelease } from "@omp-app/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { desktopBridge } from "../desktop/bridge";
import { serverUpdate } from "./appUpdates";

/** How often an update under way is read again. */
const FOLLOW_MS = 3_000;

/** A version as said: a server run from its source says "dev" (`omp-app.ts`) or its package's "0.0.0" (`dev.ts`). */
const versionWords = (version: string): string =>
  version === "dev" || version === "0.0.0"
    ? "a development build of omp-app"
    : `omp-app ${version}`;

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** "Nov 20": a release's or an update's day, in this browser's time. */
const dayOf = (at: string): string =>
  new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * The release the server runs, and in the desktop window, the desktop app's own (its pages come from the server, so the
 * two can differ); null until known, and the desktop's stays null outside the window or in a desktop app without the
 * version command.
 */
export function useAppVersions(client: AppClient): {
  readonly server: string | null;
  readonly desktop: string | null;
} {
  const [server, setServer] = useState<string | null>(null);
  const [desktop, setDesktop] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    client
      .port(AppPort)
      .serverInfo({})
      .then(
        (info) => alive && setServer(info.serverVersion),
        () => undefined,
      );
    desktopBridge()
      ?.invoke("plugin:app|version")
      .then(
        (version) => alive && typeof version === "string" && setDesktop(version),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [client]);
  return { server, desktop };
}

/** A version as the Settings list's last line says it: short, "dev" for a server run from its source. */
export const shortVersion = (version: string): string => (version === "0.0.0" ? "dev" : version);

/** A command shown to copy, selected whole by one click. */
function Command({ text }: { readonly text: string }): ReactNode {
  return (
    <code className="mt-1 block rounded-md bg-l1 px-2 py-1.5 text-xs break-all text-t2 select-all">
      {text}
    </code>
  );
}

/**
 * Settings → App → omp-app: which omp-app the server runs and, in the desktop window, which the desktop app is; a newer
 * release, with Update server (the server installs it and restarts) and in the window Update this app (Ubuntu asks the
 * password, then the app restarts); the update that brought this release, with Go back.
 */
export function AppVersionSection({ client }: { readonly client: AppClient }): ReactNode {
  const { server, desktop } = useAppVersions(client);
  const [updates, setUpdates] = useState<AppUpdates | null>(null);
  /** The release Update server or Go back is about to install, while its confirmation shows. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The desktop app's own update: under way, or what to run by hand when this app cannot. */
  const [desktopStep, setDesktopStep] = useState<
    { readonly kind: "installing" } | { readonly kind: "by-hand"; readonly why: string } | null
  >(null);

  const read = (check: boolean): void => {
    client
      .port(AppPort)
      .appUpdates(check ? { check } : {})
      .then(
        (next) => setUpdates(next),
        () => undefined,
      );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per client; `read` is this render's
  useEffect(() => read(false), [client]);
  const following = updates?.job?.step === "downloading" || updates?.job?.step === "installing";
  // biome-ignore lint/correctness/useExhaustiveDependencies: followed while an update goes on
  useEffect(() => {
    if (!following) return;
    const timer = window.setInterval(() => read(false), FOLLOW_MS);
    return () => window.clearInterval(timer);
  }, [client, following]);

  const install = (version: string): void => {
    setBusy(true);
    setProblem(null);
    client
      .port(AppPort)
      .updateApp({ version })
      .then(
        (next) => {
          setUpdates(next);
          setConfirming(null);
        },
        (failure: unknown) => setProblem(`omp-app ${version} was not installed: ${words(failure)}`),
      )
      .finally(() => setBusy(false));
  };

  const newer = serverUpdate(updates);
  const job = updates?.job ?? null;
  const last = updates?.last ?? null;
  const can = updates?.install.possible === true;
  const latest = updates?.latest?.version ?? null;
  const desktopNewer =
    desktop !== null &&
    latest !== null &&
    /^\d+\.\d+\.\d+$/.test(desktop) &&
    isNewerRelease(latest, desktop)
      ? latest
      : null;
  const desktopByHand = (version: string): string =>
    `wget ${APP_RELEASES}/download/v${version}/omp-app-desktop_${version}_amd64.deb && sudo apt install ./omp-app-desktop_${version}_amd64.deb && systemctl --user restart omp-app-device`;

  const updateDesktop = (version: string): void => {
    const bridge = desktopBridge();
    if (bridge === null) return;
    setDesktopStep({ kind: "installing" });
    // The desktop app downloads its package, checks it, asks the password through Ubuntu, installs it and restarts.
    bridge.invoke("update_desktop_app", { version }).then(
      () => undefined,
      (failure: unknown) => {
        const why = words(failure);
        setDesktopStep({
          kind: "by-hand",
          why: /not found|unknown command/i.test(why)
            ? "This desktop app is older than in-app updates: install the new one by hand once."
            : `The desktop app was not updated: ${why}`,
        });
      },
    );
  };

  return (
    <section aria-label="omp-app">
      <h3 className="mt-6 text-xs font-medium text-t3">omp-app</h3>
      <p className="mt-2 text-sm text-t2">
        {server === null ? "\u00a0" : `This server runs ${versionWords(server)}.`}
      </p>
      {desktop !== null && (
        <p className="mt-1 text-sm text-t2">This desktop app is {versionWords(desktop)}.</p>
      )}
      {updates !== null && (
        <div className="mt-2 flex flex-col gap-2">
          {newer !== null && job === null && (
            <div className="flex items-center gap-4">
              <p className="min-w-0 flex-1 text-sm text-t1">
                omp-app {newer} is out
                {updates.latest === null ? "" : ` (${dayOf(updates.latest.at)})`}.
              </p>
              {can && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || confirming !== null}
                  onClick={() => setConfirming(newer)}
                >
                  Update server
                </Button>
              )}
            </div>
          )}
          {newer !== null && !updates.install.possible && (
            <div className="text-xs text-t3">
              <p>
                {updates.install.reason}
                {updates.install.command === undefined ? "" : " Run on the server's computer:"}
              </p>
              {updates.install.command !== undefined && <Command text={updates.install.command} />}
            </div>
          )}
          {newer === null && latest !== null && updates.checkProblem === undefined && (
            <p className="text-xs text-t3">This is the newest release.</p>
          )}
          {updates.checkProblem !== undefined && (
            <p className="text-xs text-t3">{updates.checkProblem}</p>
          )}
          {confirming !== null && (
            <div
              role="alertdialog"
              aria-label="Install omp-app"
              className="rounded-md border border-l2 p-3"
            >
              <p className="text-sm text-t1">Install omp-app {confirming} on the server now?</p>
              <p className="mt-1 text-xs text-t3">
                The server restarts with it: every chat reconnects, and opening a chat is slow for
                about a minute.
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => install(confirming)}>
                  Install omp-app {confirming}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {job?.step === "downloading" && (
            <p role="status" className="text-xs text-t2">
              Downloading omp-app {job.version}…
            </p>
          )}
          {job?.step === "installing" && (
            <p role="status" className="text-xs text-t2">
              Installing omp-app {job.version}: the server restarts, and this page offers to reload
              when it is back.
            </p>
          )}
          {job?.step === "failed" && (
            <p role="alert" className="text-xs text-bad-ink">
              omp-app {job.version} did not install
              {job.detail === undefined ? "." : `: ${job.detail}`}
            </p>
          )}
          {last !== null && job === null && (
            <div className="flex items-center gap-4">
              <p className="min-w-0 flex-1 text-xs text-t3">
                Updated from omp-app {last.from} on {dayOf(last.at)}.
              </p>
              {can && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || confirming !== null}
                  onClick={() => setConfirming(last.from)}
                >
                  Go back to {last.from}
                </Button>
              )}
            </div>
          )}
          {desktopNewer !== null && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-4">
                <p className="min-w-0 flex-1 text-sm text-t1">
                  This desktop app can update to omp-app {desktopNewer}.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={desktopStep?.kind === "installing"}
                  onClick={() => updateDesktop(desktopNewer)}
                >
                  Update this app
                </Button>
              </div>
              {desktopStep?.kind === "installing" && (
                <p role="status" className="text-xs text-t2">
                  Downloading omp-app {desktopNewer}; Ubuntu asks your password to install it, then
                  the app restarts.
                </p>
              )}
              {desktopStep?.kind === "by-hand" && (
                <div className="text-xs text-t3">
                  <p>{desktopStep.why} Run on this computer:</p>
                  <Command text={desktopByHand(desktopNewer)} />
                </div>
              )}
            </div>
          )}
          <div>
            <Button size="sm" variant="ghost" className="-ml-2 text-t3" onClick={() => read(true)}>
              Look for a newer release
            </Button>
          </div>
        </div>
      )}
      {problem !== null && (
        <p role="alert" className="mt-2 text-sm text-bad-ink">
          {problem}
        </p>
      )}
    </section>
  );
}
