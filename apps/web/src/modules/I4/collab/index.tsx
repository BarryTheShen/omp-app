import { useId } from "react";
import { EmptyState, ListRow, Section } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { PanelFocusToken, PanelOpenReason, PanelState } from "@/modules/U5/panel/contract";
import { PanelShell } from "@/modules/U5/panel/shell";
import type { ParticipantState, ReadOnlySessionSnapshot } from "../contract/contract";

const plainLanguageReason = "omp only offers collaboration in its terminal.";

const unavailableActions = [
  "Host a session",
  "Create a view link",
  "Join a session",
  "Leave the session",
  "Stop sharing",
  "Copy sharing link",
] as const;

export interface CollaborationPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean, reason: PanelOpenReason) => void;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
  readonly snapshot: ReadOnlySessionSnapshot;
}

function ParticipantRow({ participant }: { readonly participant: ParticipantState }) {
  const role =
    participant.role === "viewer" ? "Viewer" : participant.role === "guest" ? "Guest" : "Host";
  const presence =
    participant.presence === "active"
      ? "Active"
      : participant.presence === "left"
        ? "Left"
        : "Disconnected";
  return (
    <ListRow
      title={participant.displayName}
      detail={`${role} · ${presence}${participant.readOnly ? " · Read-only" : ""}`}
      asOption={false}
    />
  );
}

/** Collaboration is visibly terminal-only until omp provides its authoritative interface. */
export function CollaborationPanel({
  open,
  onOpenChange,
  invokingFocus,
  restoreFocus,
  snapshot,
}: CollaborationPanelProps) {
  const reasonId = useId();
  const state: PanelState = {
    open,
    title: "Collaboration",
    position: "right",
    lifecycle: "populated",
    description: "Host, view, or join a shared session.",
    error: null,
    readOnly: true,
    pendingUpdates: 0,
  };

  return (
    <PanelShell
      invokingFocus={invokingFocus}
      restoreFocus={restoreFocus}
      state={state}
      onOpenChange={onOpenChange}
      body={
        <div className="flex min-w-0 flex-col gap-4 p-4">
          <Section
            heading="Session controls"
            description={
              <span id={reasonId}>Every action is unavailable because {plainLanguageReason}</span>
            }
          >
            <div className="flex flex-col gap-3">
              {unavailableActions.map((label) => (
                <Button aria-describedby={reasonId} disabled key={label} variant="outline">
                  {label}
                </Button>
              ))}
            </div>
          </Section>
          <Section heading="Participants" variant="plain">
            {snapshot.participants.length > 0 ? (
              <div className="flex min-w-0 flex-col">
                {snapshot.participants.map((participant) => (
                  <ParticipantRow key={participant.id} participant={participant} />
                ))}
              </div>
            ) : (
              <EmptyState
                title="No participants"
                hint="Participant details will appear when shared sessions are available."
                variant="compact"
              />
            )}
          </Section>
        </div>
      }
    />
  );
}
