import type { ThreadId } from "@omp-app/contracts";
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useRightSidebar } from "@/shell";
import { Icons } from "@/tokens";
import { composerInput } from "./composer-input";
import type { EmptyStateCopy } from "./empty-state";

/** Runs `onExit` when its content leaves the screen: the overlay around it has closed, however it was closed. */
export function RunOnExit({
  onExit,
  children,
}: {
  readonly onExit: () => void;
  readonly children: ReactNode;
}) {
  const latest = useRef(onExit);
  useEffect(() => {
    latest.current = onExit;
  }, [onExit]);
  useEffect(() => () => latest.current(), []);
  return <>{children}</>;
}

export function SettingsButton({
  onOpenSettings,
  threadId,
}: {
  readonly onOpenSettings: (threadId: ThreadId | null) => void;
  readonly threadId: ThreadId | null;
}) {
  return (
    <Button
      aria-label="Settings"
      className="text-muted-foreground hover:text-foreground rounded-control grid size-7 place-items-center transition-colors"
      title="Settings"
      type="button"
      variant="ghost"
      onClick={() => onOpenSettings(threadId)}
    >
      <Icons.settings aria-hidden="true" className="size-4" />
      <span className="sr-only">Settings</span>
    </Button>
  );
}

export function EmptyTranscript({
  copy,
  action,
}: {
  readonly copy: EmptyStateCopy;
  readonly action?: ReactNode;
}) {
  return (
    <div
      className="mx-auto flex h-full w-full max-w-(--layout-thread-width) flex-col items-center justify-center px-6 py-12 text-center"
      role="status"
    >
      <p
        className="font-display text-2xl leading-snug font-[550] tracking-[-0.01em] text-balance lg:text-[1.75rem]"
        title={copy.title}
      >
        {copy.title}
      </p>
      <p className="text-muted-foreground mt-2 max-w-[40ch] text-md leading-relaxed text-pretty">
        {copy.detail}
      </p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function FocusDiagnosticPanelOnReveal({
  open,
  reveal,
  title,
}: {
  readonly open: boolean;
  readonly reveal: number;
  readonly title: string;
}) {
  const sidebar = useRightSidebar();
  const focusedReveal = useRef<number | null>(null);
  useEffect(() => {
    if (open && sidebar !== null && !sidebar.open) sidebar.show();
  }, [open, sidebar]);
  useEffect(() => {
    if (!open || sidebar?.open === false || focusedReveal.current === reveal) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      const composer = composerInput();
      if (active !== document.body && active !== composer) return;
      if (active === composer && composer instanceof HTMLTextAreaElement && composer.value !== "")
        return;
      const panel = Array.from(
        document.querySelectorAll<HTMLElement>('[data-panel-open="true"]'),
      ).find((candidate) => candidate.querySelector("h2")?.textContent?.trim() === title);
      const target = panel?.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (target === null || target === undefined) return;
      focusedReveal.current = reveal;
      target.focus({ preventScroll: true });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [open, reveal, sidebar?.open, title]);
  return null;
}
