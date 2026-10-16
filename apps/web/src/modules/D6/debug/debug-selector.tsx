import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { InlineError, ListRow, Section, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { DialogFrame } from "@/modules/U4/dialogs/common";
import type { OverlayContent, OverlayHostApi } from "@/overlay/overlay-host";
import type { RecoveryAction, RecoveryActionResult } from "../contract";
import { type RecoveryActionHandler, runRecoveryAction, safeRecoveryText } from "./recovery";

export const DEBUG_DIAGNOSTICS = [
  {
    id: "logs",
    label: "Recent logs",
    description: "View the latest diagnostic log entries.",
  },
  {
    id: "session",
    label: "Session report",
    description: "Create a bounded report from the current session.",
  },
  {
    id: "transcript",
    label: "Transcript",
    description: "Export the visible conversation transcript.",
  },
  {
    id: "cache",
    label: "Artifact cache",
    description: "Review and clear old session artifacts.",
  },
  {
    id: "artifacts",
    label: "Session artifacts",
    description: "Open artifacts saved for the current session.",
  },
] as const;

export type DebugDiagnosticId = (typeof DEBUG_DIAGNOSTICS)[number]["id"];
export type DebugDiagnosticChoice = (typeof DEBUG_DIAGNOSTICS)[number] & {
  readonly availability:
    | { readonly state: "available" }
    | { readonly state: "unavailable"; readonly reason: string };
};

const DEFAULT_CHOICES: readonly DebugDiagnosticChoice[] = DEBUG_DIAGNOSTICS.map((choice) => ({
  ...choice,
  availability: {
    state: "unavailable",
    reason: "This diagnostic is available in omp's terminal, not in the app.",
  },
}));

interface NoticeState {
  readonly title: string;
  readonly message: string;
  readonly role: "alert" | "status";
  readonly returnFocusKey?: string;
}

function messageOf(result: RecoveryActionResult): string {
  if (result.status === "unavailable") {
    return result.error?.message ?? "This action is unavailable.";
  }
  if (result.status === "failed") return result.error?.message ?? "The recovery action failed.";
  return "The recovery action is complete.";
}

function RecoveryNotice({
  title,
  message,
  close,
  role,
}: {
  readonly title: string;
  readonly message: string;
  readonly close: () => void;
  readonly role: "alert" | "status";
}) {
  return (
    <DialogFrame
      title={title}
      actions={
        <Button onClick={close} type="button">
          Close
        </Button>
      }
    >
      {role === "alert" ? (
        <InlineError message={message} />
      ) : (
        <p aria-live="polite" className="min-w-0 text-sm [overflow-wrap:anywhere]" role="status">
          {message}
        </p>
      )}
    </DialogFrame>
  );
}

/** Opens a focus-managed modal after its originating picker has already been dismissed. */
export function openRecoveryNotice(
  overlay: Pick<OverlayHostApi, "open">,
  title: string,
  message: string,
  role: "alert" | "status" = "alert",
): void {
  const safeMessage = safeRecoveryText(message, "Sensitive diagnostic details were hidden.");
  const safeTitle = safeRecoveryText(title, "Recovery notice");
  const content: OverlayContent = ({ close }) => (
    <RecoveryNotice
      close={() => close("programmatic")}
      message={safeMessage}
      role={role}
      title={safeTitle}
    />
  );
  overlay.open({ kind: "modal", label: safeTitle, width: "content", content, focus: "move" });
}

function focusRow(container: HTMLElement | null, key: string | undefined): void {
  if (!container || key === undefined) return;
  const row = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-focus-key]")).find(
    (candidate) => candidate.dataset.focusKey === key && !candidate.disabled,
  );
  row?.focus();
}

function DebugSelectorContent({
  overlay,
  close,
  choices,
  recoveryActions,
  onChoose,
  onRecoveryAction,
  modalClosed,
}: {
  readonly overlay: Pick<OverlayHostApi, "open">;
  readonly close: () => void;
  readonly choices: readonly DebugDiagnosticChoice[];
  readonly recoveryActions: readonly RecoveryAction[];
  readonly onChoose?: (id: DebugDiagnosticId) => void | Promise<void>;
  readonly onRecoveryAction?: RecoveryActionHandler;
  readonly modalClosed: { current: boolean };
}) {
  const [pendingId, setPendingId] = useState<string | undefined>();
  const [notice, setNotice] = useState<NoticeState | undefined>();
  const [confirmation, setConfirmation] = useState<RecoveryAction | undefined>();
  const [selectedDiagnostic, setSelectedDiagnostic] = useState(choices[0]?.id);
  const [selectedRecovery, setSelectedRecovery] = useState(recoveryActions[0]?.id);
  const mounted = useRef(false);
  const diagnosticsRef = useRef<HTMLDivElement>(null);
  const recoveryRef = useRef<HTMLFieldSetElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const noticeDismissRef = useRef<HTMLButtonElement>(null);
  const confirmationButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfterTransition = useRef<string | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (pendingId !== undefined) {
      closeButtonRef.current?.focus();
      return;
    }
    if (confirmation !== undefined) {
      confirmationButtonRef.current?.focus();
      return;
    }
    if (notice !== undefined) {
      noticeDismissRef.current?.focus();
      return;
    }
    focusRow(diagnosticsRef.current, focusAfterTransition.current);
    focusRow(recoveryRef.current, focusAfterTransition.current);
    focusAfterTransition.current = undefined;
  }, [confirmation, notice, pendingId]);

  const showNotice = (
    title: string,
    message: string,
    role: "alert" | "status",
    returnFocusKey?: string,
  ): void => {
    setNotice({
      title,
      message: safeRecoveryText(message, "Sensitive diagnostic details were hidden."),
      role,
      returnFocusKey,
    });
  };

  const showDetachedNotice = (title: string, message: string, role: "alert" | "status"): void => {
    openRecoveryNotice(overlay, title, message, role);
  };

  const choose = async (choice: DebugDiagnosticChoice): Promise<void> => {
    if (choice.availability.state === "unavailable") {
      showNotice(choice.label, choice.availability.reason, "status", `diagnostic:${choice.id}`);
      return;
    }
    if (!onChoose) {
      showNotice(
        choice.label,
        "This diagnostic is not connected.",
        "status",
        `diagnostic:${choice.id}`,
      );
      return;
    }
    setPendingId(choice.id);
    try {
      await onChoose(choice.id);
      if (mounted.current && !modalClosed.current) close();
    } catch (reason) {
      const raw = reason instanceof Error ? reason.message : "The diagnostic could not be opened.";
      const safe = safeRecoveryText(
        raw,
        "The diagnostic could not be opened. Sensitive details were hidden.",
      );
      if (mounted.current && !modalClosed.current) {
        showNotice("Diagnostic unavailable", safe, "alert", `diagnostic:${choice.id}`);
      } else {
        showDetachedNotice("Diagnostic unavailable", safe, "alert");
      }
    } finally {
      if (mounted.current && !modalClosed.current) setPendingId(undefined);
    }
  };

  const finishRecovery = async (action: RecoveryAction): Promise<void> => {
    setPendingId(action.id);
    try {
      const result = await runRecoveryAction(action, onRecoveryAction);
      if (!mounted.current || modalClosed.current) {
        if (result.status !== "completed") {
          showDetachedNotice(
            result.status === "unavailable" ? "Recovery unavailable" : "Recovery failed",
            messageOf(result),
            result.status === "failed" ? "alert" : "status",
          );
        }
        return;
      }
      setConfirmation(undefined);
      showNotice(
        result.status === "completed"
          ? "Recovery complete"
          : result.status === "unavailable"
            ? "Recovery unavailable"
            : "Recovery failed",
        messageOf(result),
        result.status === "failed" ? "alert" : "status",
        `recovery:${action.id}`,
      );
    } finally {
      if (mounted.current && !modalClosed.current) setPendingId(undefined);
    }
  };

  const recover = (action: RecoveryAction): void => {
    if (action.availability.state === "unavailable") {
      showNotice(
        "Recovery unavailable",
        action.availability.reason,
        "status",
        `recovery:${action.id}`,
      );
      return;
    }
    if (action.kind === "clear-local" && onRecoveryAction !== undefined) {
      setNotice(undefined);
      focusAfterTransition.current = `recovery:${action.id}`;
      setConfirmation(action);
      return;
    }
    void finishRecovery(action);
  };

  const diagnosticKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const nextIndex =
      (index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
    const next = choices[nextIndex];
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedDiagnostic(next.id);
    focusRow(diagnosticsRef.current, `diagnostic:${next.id}`);
  };

  const recoveryKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const nextIndex =
      (index + (event.key === "ArrowDown" ? 1 : -1) + recoveryActions.length) %
      recoveryActions.length;
    const next = recoveryActions[nextIndex];
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedRecovery(next.id);
    focusRow(recoveryRef.current, `recovery:${next.id}`);
  };

  const diagnosticRows = choices.map((choice, index) => (
    <ListRow
      key={choice.id}
      title={choice.label}
      detail={choice.description}
      selected={selectedDiagnostic === choice.id}
      tabIndex={selectedDiagnostic === choice.id ? 0 : -1}
      focusKey={`diagnostic:${choice.id}`}
      disabled={pendingId !== undefined || confirmation !== undefined}
      onFocus={() => setSelectedDiagnostic(choice.id)}
      onKeyDown={(event) => diagnosticKeyDown(event, index)}
      onSelect={() => void choose(choice)}
    />
  ));
  const recoveryRows = recoveryActions.map((action, index) => {
    const unavailableReason =
      action.availability.state === "unavailable" ? action.availability.reason : undefined;
    const recoveryKey = `recovery:${action.id}`;
    return (
      <ListRow
        key={action.id}
        asOption={false}
        title={action.label}
        detail={unavailableReason === undefined ? undefined : "Unavailable"}
        selected={selectedRecovery === action.id}
        tabIndex={selectedRecovery === action.id ? 0 : -1}
        focusKey={recoveryKey}
        disabled={
          pendingId !== undefined || confirmation !== undefined || unavailableReason !== undefined
        }
        onFocus={() => setSelectedRecovery(action.id)}
        onKeyDown={(event) => recoveryKeyDown(event, index)}
        onSelect={() => recover(action)}
        trailing={
          unavailableReason !== undefined ? (
            <Button
              data-focus-key={`recovery-why:${action.id}`}
              disabled={pendingId !== undefined || confirmation !== undefined}
              onClick={() =>
                showNotice(
                  "Recovery unavailable",
                  unavailableReason,
                  "status",
                  `recovery-why:${action.id}`,
                )
              }
              size="sm"
              type="button"
              variant="outline"
            >
              Why unavailable
            </Button>
          ) : undefined
        }
      />
    );
  });

  return (
    <DialogFrame
      title="Debug tools"
      description="Choose a diagnostic or a safe recovery action."
      actions={
        <Button ref={closeButtonRef} onClick={close} type="button" variant="outline">
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Section heading="Diagnostics" headingLevel={3} variant="dialog">
          <div aria-label="Diagnostic choices" ref={diagnosticsRef} role="listbox">
            {diagnosticRows}
          </div>
        </Section>
        {recoveryActions.length > 0 ? (
          <Section heading="Recovery actions" headingLevel={3} variant="dialog">
            <fieldset
              aria-label="Recovery action choices"
              className="min-w-0 border-0 p-0"
              ref={recoveryRef}
            >
              {recoveryRows}
            </fieldset>
          </Section>
        ) : null}
        {confirmation !== undefined ? (
          <Section heading="Clear saved diagnostic data?" headingLevel={3} variant="dialog">
            <p className="mb-3 min-w-0 text-sm [overflow-wrap:anywhere]">
              Remove artifacts older than 30 days? This cannot be undone.
            </p>
            <Toolbar ariaLabel="Confirm cleanup" alignment="end">
              <Button
                onClick={() => {
                  focusAfterTransition.current = `recovery:${confirmation.id}`;
                  setConfirmation(undefined);
                }}
                type="button"
                variant="outline"
              >
                Keep data
              </Button>
              <Button
                ref={confirmationButtonRef}
                disabled={pendingId !== undefined}
                onClick={() => void finishRecovery(confirmation)}
                type="button"
                variant="destructive"
              >
                Clear saved data
              </Button>
            </Toolbar>
          </Section>
        ) : null}
        {notice !== undefined ? (
          <Section heading={notice.title} headingLevel={3} variant="dialog">
            {notice.role === "alert" ? (
              <InlineError message={notice.message} />
            ) : (
              <p
                aria-live="polite"
                className="min-w-0 text-sm [overflow-wrap:anywhere]"
                role="status"
              >
                {notice.message}
              </p>
            )}
            <Button
              ref={noticeDismissRef}
              className="mt-2"
              onClick={() => {
                focusAfterTransition.current = notice.returnFocusKey;
                setNotice(undefined);
              }}
              type="button"
              variant="outline"
            >
              Dismiss notice
            </Button>
          </Section>
        ) : null}
        {pendingId !== undefined ? (
          <p className="text-muted-foreground text-sm" role="status">
            Working…
          </p>
        ) : null}
      </div>
    </DialogFrame>
  );
}

/** Launch the diagnostics picker in U0's focus-managed modal layer. */
export function openDebugSelector(
  overlay: Pick<OverlayHostApi, "open">,
  options: {
    readonly choices?: readonly DebugDiagnosticChoice[];
    readonly recoveryActions?: readonly RecoveryAction[];
    readonly onChoose?: (id: DebugDiagnosticId) => void | Promise<void>;
    readonly onRecoveryAction?: RecoveryActionHandler;
  } = {},
): void {
  const modalClosed = { current: false };
  const result = overlay.open({
    kind: "modal",
    label: "Debug tools",
    width: "viewport",
    focus: "move",
    content: ({ close }) => (
      <DebugSelectorContent
        choices={options.choices ?? DEFAULT_CHOICES}
        close={() => {
          modalClosed.current = true;
          close("programmatic");
        }}
        modalClosed={modalClosed}
        onChoose={options.onChoose}
        onRecoveryAction={options.onRecoveryAction}
        overlay={overlay}
        recoveryActions={options.recoveryActions ?? []}
      />
    ),
  });
  void result.closed.then(() => {
    modalClosed.current = true;
  });
}
