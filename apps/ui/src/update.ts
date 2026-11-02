import type { AppClient } from "@omp-app/client";
import { useEffect, useState } from "react";

/** How often an open page asks whether the app it runs is still the one served. */
const CHECK_EVERY_MS = 10 * 60_000;

/** The entry script a page of the app loads (`/assets/index-….js`), from its HTML or a path; null when there is none. */
export function entryScriptOf(text: string): string | null {
  return /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(text)?.[0] ?? null;
}

/** This page's own entry script; null under the dev server, which has none. */
function runningEntryScript(): string | null {
  for (const script of document.querySelectorAll<HTMLScriptElement>("script[src]")) {
    const entry = entryScriptOf(new URL(script.src, window.location.href).pathname);
    if (entry !== null) return entry;
  }
  return null;
}

/**
 * Whether the app was updated since this page loaded (#2787). A release or a UI deploy serves another build, while an
 * open page keeps running its own until it reloads, and the server's answers can stop fitting it ("Server returned an
 * invalid result"). Checked when the connection opens again (a release restarts the server), when the page is shown
 * or focused again (a UI deploy restarts nothing), and every 10 minutes.
 */
export function useAppUpdated(client: AppClient): boolean {
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    const mine = runningEntryScript();
    if (mine === null) return;
    let alive = true;
    let checking = false;
    const check = (): void => {
      if (!alive || checking) return;
      checking = true;
      fetch("/", { cache: "no-store" })
        .then((answer) => (answer.ok ? answer.text() : ""))
        .then((html) => {
          const served = entryScriptOf(html);
          if (alive && served !== null && served !== mine) setUpdated(true);
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    };
    const stopState = client.onConnectionState((state) => {
      if (state.state === "open") check();
    });
    const onShown = (): void => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onShown);
    window.addEventListener("focus", onShown);
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    return () => {
      alive = false;
      stopState();
      document.removeEventListener("visibilitychange", onShown);
      window.removeEventListener("focus", onShown);
      window.clearInterval(timer);
    };
  }, [client]);
  return updated;
}
