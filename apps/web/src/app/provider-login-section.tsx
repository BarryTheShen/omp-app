import type { AppClient } from "@omp-app/client";
import { AppFailure, type CapabilityMap, type ThreadId } from "@omp-app/contracts";
import { useMemo, useState } from "react";
import { Section } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { createAuthPort, ProviderLoginPanel } from "@/modules/D3/auth";
import { AUTH_CAPABILITIES } from "@/modules/D3/contract";
import type { OverlayHostApi } from "@/overlay";

/** Shown on the Providers tab when no chat is open; the tab can start one to sign in in. */
const OPEN_A_CHAT_NOTE = "Open a chat to sign in to a provider.";

/**
 * Whether the Providers tab offers provider sign-in: omp must be able to list login providers. The sign-in
 * itself runs in a chat's omp session, so with no chat open the tab offers to start one.
 */
export function providerLoginAvailable(capabilities: CapabilityMap): boolean {
  return capabilities[AUTH_CAPABILITIES.getLoginProviders]?.state === "available";
}

/**
 * Refuses provider login with a plain reason when omp cannot list its login providers. The `/login` command and
 * the palette's Provider login call it first. The refused-key notice does not: it has always opened the dialog.
 */
export function requireProviderLogin(capabilities: CapabilityMap): void {
  if (providerLoginAvailable(capabilities)) return;
  throw new AppFailure({
    code: "unavailable",
    message: "Provider login is unavailable for this session.",
    retryable: false,
    capability: AUTH_CAPABILITIES.getLoginProviders,
  });
}

/**
 * The no-chat state of provider sign-in: omp signs in inside a chat, so this starts one and the sign-in opens
 * in it. A failed start says why, in the failure's own words.
 */
function ProviderSignInStart({ onStart }: { readonly onStart: () => Promise<void> }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async (): Promise<void> => {
    setStarting(true);
    setError(null);
    try {
      await onStart();
    } catch (failure) {
      setError(
        failure instanceof AppFailure ? failure.appError.message : "The chat could not be started.",
      );
    } finally {
      setStarting(false);
    }
  };
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-muted-foreground text-sm">
        Sign-in runs inside a chat, because omp signs in there. Start a chat, and sign-in opens in
        it.
      </p>
      <Button
        disabled={starting}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => void start()}
      >
        {starting ? "Starting a chat…" : "Start a chat to sign in"}
      </Button>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Opens provider sign-in for a chat's omp in a dialog over the app: the page Settings > Providers shows. A refused
 * key's "Sign in…" opens it as it always has. `/login` and the palette's Provider login open it with `restoreFocus`
 * (the composer), because the palette has already closed by then, and the dialog returns focus there when it closes.
 */
export function openProviderSignIn({
  overlay,
  client,
  threadId,
  capabilities,
  restoreFocus,
}: {
  readonly overlay: OverlayHostApi;
  readonly client: AppClient;
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  readonly restoreFocus?: HTMLElement;
}): void {
  const auth = createAuthPort({ client, threadId, capabilities });
  overlay.open({
    kind: "modal",
    label: "Provider login",
    width: "content",
    ...(restoreFocus === undefined ? {} : { restoreFocus }),
    content: () => (
      <div className="max-h-[75vh] overflow-y-auto">
        <ProviderLoginPanel auth={auth} />
      </div>
    ),
  });
}

/** The provider sign-in section (D3) on the settings Providers tab. */
export function ProviderLoginSection({
  client,
  threadId,
  capabilities,
  onStartChat,
}: {
  readonly client: AppClient;
  readonly threadId: ThreadId | null;
  readonly capabilities: CapabilityMap;
  /** Starts a chat to sign in in, when the tab has no chat open; omitted, the tab only says a chat is needed. */
  readonly onStartChat?: () => Promise<void>;
}) {
  const auth = useMemo(
    () => (threadId === null ? null : createAuthPort({ client, threadId, capabilities })),
    [client, threadId, capabilities],
  );
  if (auth === null) {
    return (
      <Section heading="Provider login" variant="plain">
        {onStartChat === undefined ? (
          <p className="text-muted-foreground text-sm">{OPEN_A_CHAT_NOTE}</p>
        ) : (
          <ProviderSignInStart onStart={onStartChat} />
        )}
      </Section>
    );
  }
  return <ProviderLoginPanel auth={auth} />;
}
