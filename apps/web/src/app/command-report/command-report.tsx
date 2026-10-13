import type { ThreadId } from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Surface } from "@/layout";
import { PanelShell } from "@/modules/U5/panel/shell";
import { useRightSidebar } from "@/shell";

/** omp's words for one command, with every line kept: what the command output panel shows. */
export interface CommandReport {
  readonly command: string;
  readonly text: string;
}

/** A report belongs to the chat its command ran in; another chat does not show it. */
export interface ShownCommandReport extends CommandReport {
  readonly threadId: ThreadId;
}

const COMPOSER_INPUT = 'textarea[aria-label="Message input"]';

/**
 * The output of the last command that printed more than one line, kept until the person closes it. It is one of
 * the right sidebar's panels: the layout lists it only while it is open in the chat on screen.
 */
export function useCommandReport({ threadId }: { readonly threadId: ThreadId }): {
  readonly surface: Surface;
  readonly show: (report: CommandReport) => void;
  readonly reveal: number;
} {
  const [state, setState] = useState<{
    readonly shown: ShownCommandReport | null;
    readonly reveal: number;
  }>({ shown: null, reveal: 0 });
  const show = useCallback(
    (report: CommandReport) => {
      setState((current) => ({ shown: { ...report, threadId }, reveal: current.reveal + 1 }));
    },
    [threadId],
  );
  const close = useCallback(() => {
    setState((current) => ({ ...current, shown: null }));
    // Closing returns the person to the composer they typed the command in.
    document.querySelector<HTMLTextAreaElement>(COMPOSER_INPUT)?.focus();
  }, []);
  const visible = state.shown !== null && state.shown.threadId === threadId ? state.shown : null;
  return {
    surface: {
      title: "Command output",
      open: visible !== null,
      reveal: state.reveal,
      grow: true,
      render: () =>
        visible === null ? null : <CommandOutputPanel onClose={close} report={visible} />,
    },
    show,
    reveal: state.reveal,
  };
}

/**
 * Opens the right sidebar when a command's output arrives while the sidebar is closed (a drawer on a phone). It
 * renders nothing; it is mounted beside the panels, so it runs whether or not the sidebar is open.
 */
export function RevealCommandOutput({ reveal }: { readonly reveal: number }) {
  const sidebar = useRightSidebar();
  const seen = useRef(reveal);
  useEffect(() => {
    if (reveal === seen.current) return;
    seen.current = reveal;
    sidebar?.show();
  }, [reveal, sidebar]);
  return null;
}

/** omp's words in a fixed-width block, every line in order; the panel scrolls, and its text can be selected and copied. */
function CommandOutputPanel({
  report,
  onClose,
}: {
  readonly report: CommandReport;
  readonly onClose: () => void;
}) {
  return (
    <PanelShell
      body={
        // The report scrolls inside its own container, so the shell's body never overflows: no "New updates" badge
        // on open or when the chat re-renders (the same grammar as the Agent Hub's roster).
        <div className="h-full min-h-0 overflow-y-auto">
          <pre
            className="border-border bg-muted/40 text-foreground min-w-0 max-w-full rounded-lg border p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
            data-command-output="true"
          >
            {report.text}
          </pre>
        </div>
      }
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      state={{
        open: true,
        lifecycle: "populated",
        position: "right",
        title: "Command output",
        description: report.command,
        error: null,
        readOnly: true,
        pendingUpdates: 0,
      }}
    />
  );
}
