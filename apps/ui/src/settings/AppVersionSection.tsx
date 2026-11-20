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
 * Settings → App → omp-app: the release the server runs, and in the desktop window, the desktop app's own (its pages
 * come from the server, so the two can differ). A desktop app without the version command says nothing of its own.
 */
export function AppVersionSection({ client }: { readonly client: AppClient }): ReactNode {
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
