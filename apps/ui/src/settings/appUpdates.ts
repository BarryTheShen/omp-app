import type { AppClient } from "@omp-app/client";
import { AppPort, type AppUpdates, isNewerRelease } from "@omp-app/contracts";
import { useEffect, useState } from "react";

/** How often the sidebar asks whether a newer release is out (the server looks on GitHub at most hourly). */
const MARK_EVERY_MS = 60 * 60_000;

/** A newer release than the server's, which this server could install itself or says how to. */
export function serverUpdate(updates: AppUpdates | null): string | null {
  const latest = updates?.latest?.version;
  if (updates === null || latest === undefined) return null;
  return /^\d+\.\d+\.\d+$/.test(updates.installed) &&
    updates.installed !== "0.0.0" &&
    isNewerRelease(latest, updates.installed)
    ? latest
    : null;
}

/**
 * Whether a newer omp-app than the server's is out, for the mark on the Settings button: asked at once and hourly. A
 * server older than in-app updates answers nothing, and no mark shows.
 */
export function useUpdateAvailable(client: AppClient): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    const ask = (): void => {
      client
        .port(AppPort)
        .appUpdates({})
        .then(
          (updates) => alive && setAvailable(serverUpdate(updates) !== null),
          () => undefined,
        );
    };
    ask();
    const timer = window.setInterval(ask, MARK_EVERY_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [client]);
  return available;
}
