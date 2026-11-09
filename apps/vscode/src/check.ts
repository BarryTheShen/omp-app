/**
 * Whether omp app at an address would show in VS Code's panel, asked of the app before its page is framed: a frame
 * that is refused, or that never loads, leaves VS Code's panel blank, with nothing to say why.
 */

/** How long the app has to answer. */
export const CHECK_MS = 8_000;

/** The kinds of VS Code's panel, as the app's frame rule (`frame-ancestors`) names them. */
const PANEL_SOURCES = ["vscode-webview:", "vscode-file:"] as const;

/** Whether a `Content-Security-Policy` lets VS Code's panel frame the page: no `frame-ancestors`, or one naming it. */
export function framesVsCode(policy: string | null): boolean {
  if (policy === null) return true;
  const directive = policy
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find(([name]) => name?.toLowerCase() === "frame-ancestors");
  if (directive === undefined) return true;
  const sources = new Set(directive.slice(1).map((source) => source.toLowerCase()));
  return sources.has("*") || PANEL_SOURCES.every((source) => sources.has(source));
}

/** Why the app at `app` (an origin) would not show in the panel, in words for the panel; null when it would. */
export async function whyNotShown(app: string, signal?: AbortSignal): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(new URL("/lite", app), {
      redirect: "manual",
      signal: signal ?? AbortSignal.timeout(CHECK_MS),
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const reason = cause instanceof Error ? cause.message : String(cause);
    return `omp app can't be reached at ${app} (${reason}). Check the address, and that this computer can reach that server.`;
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok)
    return `${app} answered ${response.status}${response.statusText === "" ? "" : ` ${response.statusText}`} instead of omp app's page. Check that the address is the one you open omp app at in a browser.`;
  if (!framesVsCode(response.headers.get("content-security-policy")))
    return `omp app at ${app} doesn't let VS Code show it yet. In omp app, turn on Settings → App → Integrations → VS Code, then click Try again.`;
  return null;
}
