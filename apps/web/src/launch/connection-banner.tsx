import { Icons } from "@/tokens";
import { LogHint } from "./log-hint";

const CONNECTION_LOST_TEXT = "Connection lost. Reconnecting to omp-app…";

/** After a long outage: what to do, in the same words the full-page screens use. */
const UNREACHABLE_TEXT =
  "omp-app is not answering. Check that it is still running, then reload this page.";

/** Why the composer will not send yet. The typed text stays in the composer. */
export const SEND_BLOCKED_TEXT =
  "Can't send yet. Your message stays here until omp-app reconnects.";

/**
 * A status line over the chat while the app reconnects. It keeps the chat, the draft and the reader's place as
 * they are. After a long outage it also says what to do and where the app's log is.
 */
export function ConnectionBanner({ unreachable = false }: { readonly unreachable?: boolean }) {
  return (
    <div
      aria-live="polite"
      className="text-warning flex min-w-0 flex-col gap-(--space-2xs) text-xs"
      data-connection-banner="true"
      role="status"
    >
      <p className="flex min-w-0 items-start gap-(--space-xs)">
        <Icons.warning aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0">{unreachable ? UNREACHABLE_TEXT : CONNECTION_LOST_TEXT}</span>
      </p>
      {unreachable && <LogHint />}
    </div>
  );
}
