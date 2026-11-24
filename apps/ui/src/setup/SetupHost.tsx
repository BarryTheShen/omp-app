import type { AppClient } from "@omp-app/client";
import { type ReactNode, useEffect } from "react";
import { setSetupOpen, useSetupOpen } from "./open";
import { SetupDialog } from "./SetupDialog";

/** The setup, wherever it is asked from (`setSetupOpen`, `reviewSetupProposal`); the settings sheet closes first. */
export function SetupHost({
  client,
  onSignIn,
  onOpening,
  onFineTune,
}: {
  readonly client: AppClient;
  readonly onSignIn: () => void;
  readonly onOpening: () => void;
  /** Starts the AI round in a new chat (`interviewPrompt`). */
  readonly onFineTune: () => void;
}): ReactNode {
  const { open, proposal } = useSetupOpen();
  useEffect(() => {
    if (open) onOpening();
  }, [open, onOpening]);
  return (
    <SetupDialog
      client={client}
      open={open}
      proposal={proposal}
      onOpenChange={setSetupOpen}
      onSignIn={onSignIn}
      onFineTune={onFineTune}
    />
  );
}
