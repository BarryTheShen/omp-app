import { useEffect, useRef, useState } from "react";
import { InlineError, Section, SettingRow } from "../../../components/blocks";
import { Button } from "../../../components/ui/button";
import type { ProviderSetupController, SetupCommand, SetupOutcome } from "./setup";
import { SETUP_CAPABILITIES } from "./setup";

export interface ProviderSetupPanelProps {
  readonly setup: ProviderSetupController;
}

type SetupFailure = Extract<SetupOutcome, { state: "error" | "unavailable" }>;

function errorMessage(outcome: SetupFailure): string {
  if (outcome.state === "error" && outcome.reason === "agent-invoked") {
    return "omp could not open provider setup from here.";
  }
  const error = outcome.error.appError;
  if (error.capability === SETUP_CAPABILITIES.setupCommands) {
    return "omp can only open provider setup in its terminal.";
  }
  if (error.capability === SETUP_CAPABILITIES.wizard) {
    return "omp only offers the setup wizard in its terminal.";
  }
  switch (error.code) {
    case "unavailable":
      return "Provider setup is unavailable for this session.";
    case "cancelled":
      return "Provider setup was cancelled.";
    case "timeout":
      return "Provider setup timed out. Try again.";
    case "conflict":
      return "Provider setup changed elsewhere. Try again.";
    case "permission":
      return "You do not have permission to change provider setup.";
    default:
      return "Provider setup failed. Try again.";
  }
}

function outcomeMessage(outcome: SetupOutcome): string {
  if (outcome.state === "completed") {
    return "Provider setup finished. Reload to use the new settings.";
  }
  if (outcome.state === "aborted") return "Provider setup was cancelled.";
  return errorMessage(outcome);
}

function ProviderSetupPanel({ setup }: ProviderSetupPanelProps) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SetupOutcome | null>(null);
  const abort = useRef<AbortController | null>(null);
  const gatewayAvailable =
    setup.capabilities()[SETUP_CAPABILITIES.commandGateway]?.state === "available";
  const setupCommandsAvailable = setup.setupCommandsAvailable();
  const wizardAvailable = setup.wizardAvailable();

  useEffect(() => () => abort.current?.abort(), []);

  const run = async (command: SetupCommand) => {
    if (busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await setup.run(command, { signal: controller.signal }));
    } finally {
      if (abort.current === controller) abort.current = null;
      setBusy(false);
    }
  };

  const runWizard = async () => {
    if (busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await setup.openWizard({ signal: controller.signal }));
    } finally {
      if (abort.current === controller) abort.current = null;
      setBusy(false);
    }
  };

  return (
    <Section
      heading="Provider setup"
      description="Configure providers through omp without exposing credentials in the app."
    >
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!gatewayAvailable || !setupCommandsAvailable || busy}
          type="button"
          variant="outline"
          onClick={() => void run("/setup providers")}
        >
          Set up providers
        </Button>
      </div>
      {!setupCommandsAvailable && (
        <p className="text-muted-foreground mt-2 text-sm" role="status">
          omp can only open provider setup in its terminal.
        </p>
      )}
      {setupCommandsAvailable && !gatewayAvailable && (
        <p className="text-muted-foreground mt-2 text-sm" role="status">
          Provider setup is unavailable for this session.
        </p>
      )}
      <SettingRow
        title="Provider setup wizard"
        layout="stacked"
        description={
          wizardAvailable ? undefined : "omp only offers the setup wizard in its terminal."
        }
      >
        <div className="flex justify-start">
          <Button
            className="w-fit"
            disabled={!wizardAvailable || busy}
            type="button"
            variant="outline"
            onClick={() => void runWizard()}
          >
            Open setup wizard
          </Button>
        </div>
      </SettingRow>
      {busy && (
        <p className="text-muted-foreground mt-4 text-sm" role="status">
          Provider setup is running…
        </p>
      )}
      {outcome?.state === "error" && (
        <InlineError
          heading="Provider setup failed"
          message={errorMessage(outcome)}
          onRetry={outcome.reason === "agent-invoked" ? undefined : () => void run(outcome.command)}
        />
      )}
      {outcome && outcome.state !== "error" && (
        <p className="mt-4 text-sm" role="status">
          {outcomeMessage(outcome)}
        </p>
      )}
    </Section>
  );
}

export { ProviderSetupPanel };
