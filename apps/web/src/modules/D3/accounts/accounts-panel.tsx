import type { AppError, RedactedProviderAccount } from "@omp-app/contracts";
import { useEffect, useRef, useState } from "react";
import { EmptyState, InlineError, ListRow, Section } from "../../../components/blocks";
import { Button } from "../../../components/ui/button";
import type { ProviderAccountActionFailure, ProviderAccountsController } from "./accounts";

export interface ProviderAccountsPanelProps {
  readonly accounts: ProviderAccountsController;
  readonly available: boolean;
}

function errorMessage(failure: ProviderAccountActionFailure | AppError): string {
  const action = "action" in failure ? failure.action : undefined;
  const error = "error" in failure ? failure.error : failure;
  if (action === "reset" && error.code === "unavailable") {
    return "omp can't reset usage from here.";
  }
  if (action === "pin" && error.code === "unavailable") {
    return "Only provider sign-ins can be used for a single chat.";
  }
  switch (error.code) {
    case "unavailable":
      return "This provider account action is not available here.";
    case "not_found":
      return "This provider account is no longer available. Refresh the list and try again.";
    case "conflict":
      return "The provider account changed elsewhere. Refresh the list and try again.";
    case "permission":
      return "You do not have permission to change this provider account.";
    case "timeout":
      return "The provider account request timed out. Try again.";
    case "cancelled":
      return "The provider account request was cancelled.";
    default:
      return "The provider account request failed. Try again.";
  }
}

function sourceLabel(account: RedactedProviderAccount): string {
  const source = {
    "agent-db": "saved on this device",
    config: "configuration file",
    env: "environment variable",
    oauth: "provider sign-in",
  }[account.source];
  return account.expiresAt
    ? `${source} · expires ${new Date(account.expiresAt).toLocaleDateString()}`
    : source;
}

function ProviderAccountsPanel({ accounts, available }: ProviderAccountsPanelProps) {
  const [state, setState] = useState(accounts.getState());
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<ProviderAccountActionFailure | null>(
    accounts.actionFailure(),
  );
  const actionAbort = useRef<AbortController | null>(null);
  const refreshAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    setState(accounts.getState());
    setBusyAccountId(null);
    setActionFailure(accounts.actionFailure());
    accounts.clearActionFailure();
    if (!available) return;
    const abort = new AbortController();
    void accounts.reload(abort.signal).then((next) => {
      if (!abort.signal.aborted) setState(next);
    });
    return () => {
      abort.abort();
      actionAbort.current?.abort();
      refreshAbort.current?.abort();
    };
  }, [accounts, available]);

  const refresh = async () => {
    if (refreshAbort.current) return;
    const abort = new AbortController();
    refreshAbort.current = abort;
    try {
      const next = await accounts.reload(abort.signal);
      if (!abort.signal.aborted) {
        setState(next);
        setActionFailure(null);
        accounts.clearActionFailure();
      }
    } finally {
      if (refreshAbort.current === abort) refreshAbort.current = null;
    }
  };

  const runAction = async (
    account: RedactedProviderAccount,
    action: "logout" | "pin" | "reset",
  ) => {
    if (actionAbort.current) return;
    const abort = new AbortController();
    actionAbort.current = abort;
    setBusyAccountId(account.id);
    try {
      if (action === "logout") await accounts.logout(account, abort.signal);
      else if (action === "pin") await accounts.pin(account, abort.signal);
      else await accounts.resetUsage(account, abort.signal);
      if (!abort.signal.aborted) {
        setState(accounts.getState());
        setActionFailure(accounts.actionFailure());
      }
    } finally {
      if (actionAbort.current === abort) actionAbort.current = null;
      if (!abort.signal.aborted) setBusyAccountId(null);
    }
  };

  if (!available) {
    return (
      <Section
        heading="Provider accounts"
        description="Manage saved provider logins for this device."
      >
        <p
          className="rounded-lg border border-warning/40 bg-warning-surface p-3 text-sm text-warning-surface-foreground"
          role="status"
        >
          Provider account controls are unavailable for this session.
        </p>
      </Section>
    );
  }

  return (
    <Section
      heading="Provider accounts"
      description="Manage saved provider logins for this device."
    >
      {state.state === "loading" && (
        <p className="text-muted-foreground text-sm" role="status">
          Loading provider accounts…
        </p>
      )}
      {state.state === "empty" && (
        <EmptyState
          title="No saved provider accounts"
          hint="Sign in to a provider to add an account."
        />
      )}
      {state.state === "error" && (
        <InlineError message={errorMessage(state.error)} onRetry={() => void refresh()} />
      )}
      {actionFailure && (
        <InlineError
          message={errorMessage(actionFailure)}
          details={
            actionFailure.action === "logout" && actionFailure.error.code === "conflict"
              ? actionFailure.error.message
              : undefined
          }
          actions={
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => {
                setActionFailure(null);
                accounts.clearActionFailure();
              }}
            >
              Dismiss
            </Button>
          }
        />
      )}
      {busyAccountId && (
        <p className="text-muted-foreground text-sm" role="status">
          Updating provider account…
        </p>
      )}
      {state.state === "ready" && (
        <ul className="flex min-w-0 flex-col gap-2">
          {state.accounts.map((account) => (
            <li
              className="border-border/70 flex min-w-0 flex-wrap items-center gap-3 rounded-lg border p-3"
              key={account.id}
            >
              <ListRow
                title={account.label}
                detail={`${sourceLabel(account)}${account.active ? " · active" : ""}`}
                asOption={false}
                selected={state.selectedAccountId === account.id}
                onSelect={() => {
                  accounts.select(account.id);
                  setState(accounts.getState());
                }}
              />
              <div className="flex flex-wrap gap-2">
                {account.source === "oauth" && (
                  <Button
                    disabled={busyAccountId !== null || account.active}
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() => void runAction(account, "pin")}
                  >
                    Use for this chat
                  </Button>
                )}
                <Button
                  disabled={busyAccountId !== null}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => void runAction(account, "reset")}
                >
                  Reset usage
                </Button>
                <Button
                  disabled={busyAccountId !== null}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => void runAction(account, "logout")}
                >
                  Log out
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {state.state === "ready" && state.selectedAccountId && (
        <Button
          className="self-start"
          disabled={busyAccountId !== null}
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => {
            accounts.clear();
            setState(accounts.getState());
          }}
        >
          Clear selection
        </Button>
      )}
    </Section>
  );
}

export { ProviderAccountsPanel };
