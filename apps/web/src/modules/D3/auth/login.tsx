import type { AppError } from "@omp-app/contracts";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import type { AuthPort, AuthStatus, LoginProvider } from "../contract";
import { AUTH_CAPABILITIES, AuthStatusSchema } from "../contract";

export interface ProviderLoginPanelProps {
  readonly auth: AuthPort;
}

function statusLabel(status: AuthStatus["state"]): string {
  switch (status) {
    case "waiting-for-browser":
      return "Waiting for browser";
    case "waiting-for-callback":
      return "Waiting for callback";
    case "authenticated":
      return "Authenticated";
    case "cancelled":
      return "Cancelled";
    case "error":
      return "Error";
    case "loading":
      return "Loading";
    default:
      return "Ready";
  }
}

function statusClass(status: AuthStatus["state"]): string {
  if (status === "authenticated")
    return "border-success/30 bg-success-surface text-success-surface-foreground";
  if (status === "error")
    return "border-danger/30 bg-danger-surface text-danger-surface-foreground";
  if (status === "cancelled") return "border-border bg-muted text-muted-foreground";
  return "border-info/30 bg-info-surface text-info-surface-foreground";
}

function safeErrorMessage(error: AppError | null): string | null {
  if (!error) return null;
  if (error.code === "unavailable") return "Provider login is unavailable for this session.";
  if (error.code === "timeout") return "Provider login timed out. Try again.";
  if (error.code === "cancelled") return "Provider login was cancelled.";
  if (error.code === "permission") return "The provider declined the login request.";
  return "Provider login failed. Try again.";
}

/**
 * Provider discovery/login body. The actual authorization URL and manual callback input are routed
 * by U4's ExtensionUiRequestRouter; this body never receives or stores either value.
 */
export function ProviderLoginPanel({ auth }: ProviderLoginPanelProps) {
  const [providers, setProviders] = useState<readonly LoginProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [status, setStatus] = useState<AuthStatus>(() => AuthStatusSchema.parse({ state: "idle" }));
  const loginAbort = useRef<AbortController | null>(null);
  const capabilities = auth.capabilities();
  const canDiscover = capabilities[AUTH_CAPABILITIES.getLoginProviders]?.state === "available";
  const canLogin = capabilities[AUTH_CAPABILITIES.login]?.state === "available";

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void auth
      .getLoginProviders({ signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setProviders(next);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(isAppError(failure) ? failure : null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [auth]);

  const login = (provider: LoginProvider): void => {
    loginAbort.current?.abort();
    const controller = new AbortController();
    loginAbort.current = controller;
    setError(null);
    setStatus(AuthStatusSchema.parse({ state: "waiting-for-browser", providerId: provider.id }));
    void auth
      .login(provider.id, { signal: controller.signal })
      .then((next) => setStatus(next))
      .catch((failure: unknown) => {
        if (controller.signal.aborted) {
          setStatus(AuthStatusSchema.parse({ state: "cancelled", providerId: provider.id }));
          return;
        }
        setError(isAppError(failure) ? failure : null);
        setStatus(AuthStatusSchema.parse({ state: "error", providerId: provider.id }));
      });
  };

  const cancel = (): void => {
    loginAbort.current?.abort();
    loginAbort.current = null;
    setStatus(AuthStatusSchema.parse({ state: "cancelled", providerId: status.providerId }));
  };

  const statusError = safeErrorMessage(status.error ?? error);
  return (
    <section
      aria-labelledby="d3-provider-login-title"
      className="border-border bg-card flex w-full max-w-xl min-w-0 flex-col gap-4 rounded-xl border p-4 shadow-xs sm:p-6"
      data-testid="d3-provider-login"
    >
      <header>
        <h1 className="text-lg font-semibold tracking-tight" id="d3-provider-login-title">
          Provider login
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Choose a configured provider. Sign-in opens in a new tab; if it can't return to the app,
          paste the code or redirect address here.
        </p>
      </header>
      {!canDiscover && (
        <p
          className="border-warning/40 bg-warning-surface text-warning-surface-foreground rounded-lg border p-3 text-sm"
          role="status"
        >
          Provider discovery is unavailable for this session.
        </p>
      )}
      {loading && (
        <p className="text-muted-foreground text-sm" role="status">
          Loading providers…
        </p>
      )}
      {!loading && providers.length === 0 && !error && (
        <p className="text-muted-foreground rounded-lg bg-muted/30 p-3 text-sm">
          No providers are configured.
        </p>
      )}
      {error && (
        <p
          className="border-danger/40 bg-danger-surface text-danger-surface-foreground rounded-lg border p-3 text-sm"
          role="alert"
        >
          {safeErrorMessage(error)}
        </p>
      )}
      <ul className="flex min-w-0 flex-col gap-2" data-testid="d3-provider-list">
        {providers.map((provider) => (
          <li
            className="border-border/70 flex min-w-0 items-center justify-between gap-3 rounded-lg border p-3"
            key={provider.id}
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">{provider.name}</div>
              {!provider.authenticated && (
                <div className="text-muted-foreground text-xs">
                  {provider.available ? "Available" : "Unavailable"}
                </div>
              )}
            </div>
            {provider.authenticated ? (
              <span className="border-success/30 bg-success-surface text-success-surface-foreground rounded-full border px-2 py-1 text-xs">
                Authenticated
              </span>
            ) : (
              <Button
                disabled={
                  !canLogin ||
                  !provider.available ||
                  status.state === "waiting-for-browser" ||
                  status.state === "waiting-for-callback"
                }
                size="sm"
                type="button"
                variant="outline"
                onClick={() => login(provider)}
              >
                Log in
              </Button>
            )}
          </li>
        ))}
      </ul>
      {status.providerId && status.state !== "idle" && (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="d3-login-status">
          <span className={`rounded-full border px-2 py-1 text-xs ${statusClass(status.state)}`}>
            {statusLabel(status.state)}
          </span>
          <span className="text-muted-foreground">{status.providerId}</span>
          {(status.state === "waiting-for-browser" || status.state === "waiting-for-callback") && (
            <Button size="sm" type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          )}
        </div>
      )}
      {statusError && status.state === "error" && (
        <p className="text-danger-surface-foreground text-sm" role="alert">
          {statusError}
        </p>
      )}
    </section>
  );
}

function isAppError(value: unknown): value is AppError {
  return value instanceof Error && "appError" in value && typeof value.appError === "object";
}
