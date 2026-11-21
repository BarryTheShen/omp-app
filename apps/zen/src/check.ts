/**
 * Why omp app's page did not open in the sidebar, asked of the app once the page has not answered (`onNoAnswer`): a
 * frame that cannot load shows the browser's own error page, which says nothing about omp app. The extension's pages
 * may fetch any address (`host_permissions`), so the sidebar can ask the app itself. VS Code's panel asks the same
 * (`apps/vscode/src/check.ts`); the sidebar is framed by `moz-extension:` pages instead.
 */

/** How long the app has to answer. */
export const CHECK_MS = 8_000;

/**
 * Whether a `Content-Security-Policy` lets this extension's pages frame the app: no `frame-ancestors`, or one naming
 * every extension of this browser's kind (`moz-extension:` in Firefox, `chrome-extension:` in Chrome and Edge), this
 * one (`moz-extension://<uuid>`, `chrome-extension://<id>`) or any page (`*`).
 */
export function framesSidebar(policy: string | null, extension: string): boolean {
  if (policy === null) return true;
  const directive = policy
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find(([name]) => name?.toLowerCase() === "frame-ancestors");
  if (directive === undefined) return true;
  const sources = new Set(directive.slice(1).map((source) => source.toLowerCase()));
  const scheme = `${new URL(extension).protocol}`;
  return sources.has("*") || sources.has(scheme) || sources.has(extension.toLowerCase());
}

/** Why the app's page did not open: `text` says so in words for the sidebar. */
export interface NotShown {
  readonly kind: "unreachable" | "not-the-app" | "not-allowed";
  readonly text: string;
}

/**
 * Why the app at `app` (an origin) would not open in the sidebar; null when it would, as far as its address tells.
 * `extension` is the sidebar's own origin (`moz-extension://<uuid>`).
 */
export async function whyNotShown(
  app: string,
  extension: string,
  signal: AbortSignal = AbortSignal.timeout(CHECK_MS),
): Promise<NotShown | null> {
  let response: Response;
  try {
    response = await fetch(new URL("/lite", app), {
      redirect: "manual",
      signal,
      credentials: "omit",
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    // Firefox's own message ends with a full stop ("NetworkError when attempting to fetch resource."): the sentence has one.
    const reason = (cause instanceof Error ? cause.message : String(cause)).replace(/\.$/, "");
    return {
      kind: "unreachable",
      text: `omp app can't be reached at ${app} (${reason}). Check that omp app is running, that the address is right, and that this computer can reach that server.`,
    };
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok)
    return {
      kind: "not-the-app",
      text: `${app} answered ${response.status}${response.statusText === "" ? "" : ` ${response.statusText}`} instead of omp app's page. Check that the address is the one you open omp app at in a browser.`,
    };
  if (!framesSidebar(response.headers.get("content-security-policy"), extension))
    return {
      kind: "not-allowed",
      text: `omp app at ${app} doesn't let this sidebar show it: it is older than this extension. Update omp app, then click Try again.`,
    };
  return null;
}

/** What the sidebar says when the page did not open: why, or, when the app answers as it should, what to try. */
export function noAnswerText(app: string, why: NotShown | null): string {
  return (
    why?.text ??
    `omp app at ${app} answers, but its page didn't open in this sidebar. Click Try again; if it stays like this, open ${app} in a tab to see whether it opens there.`
  );
}
