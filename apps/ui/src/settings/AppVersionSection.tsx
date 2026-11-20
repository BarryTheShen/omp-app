import type { AppClient } from "@omp-app/client";
import { AppPort } from "@omp-app/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { desktopBridge } from "../desktop/bridge";

/** A version as said: a server run from its source says "dev" (`omp-app.ts`) or its package's "0.0.0" (`dev.ts`). */
const versionWords = (version: string): string =>
  version === "dev" || version === "0.0.0"
    ? "a development build of omp-app"
    : `omp-app ${version}`;

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

/** Settings → App → omp-app: which omp-app the server runs, and in the desktop window, which the desktop app is. */
export function AppVersionSection({ client }: { readonly client: AppClient }): ReactNode {
  const { server, desktop } = useAppVersions(client);
  return (
    <section aria-label="omp-app">
      <h3 className="mt-6 text-xs font-medium text-t3">omp-app</h3>
      <p className="mt-2 text-sm text-t2">
        {server === null ? "\u00a0" : `This server runs ${versionWords(server)}.`}
      </p>
      {desktop !== null && (
        <p className="mt-1 text-sm text-t2">This desktop app is {versionWords(desktop)}.</p>
      )}
    </section>
  );
}
