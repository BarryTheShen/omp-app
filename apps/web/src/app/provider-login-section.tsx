import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, ThreadId } from "@omp-app/contracts";
import { useMemo } from "react";
import { Section } from "@/components/blocks";
import { createAuthPort, ProviderLoginPanel } from "@/modules/D3/auth";
import { AUTH_CAPABILITIES } from "@/modules/D3/contract";
import type { OverlayHostApi } from "@/overlay";

/**
 * Whether the Providers tab offers provider sign-in: omp must be able to list login providers. The
 * sign-in itself runs in the open chat's omp session, so with no chat open the section says so.
 */
export function providerLoginAvailable(capabilities: CapabilityMap): boolean {
  return capabilities[AUTH_CAPABILITIES.getLoginProviders]?.state === "available";
}

/**
 * Opens provider sign-in for the session's omp in a dialog over the chat. A refused key's "Sign in…"
 * button uses it, so the same sign-in screen opens from the notice as from settings.
 */
export function openProviderSignIn({
  overlay,
  client,
  threadId,
  capabilities,
}: {
  readonly overlay: OverlayHostApi;
  readonly client: AppClient;
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
}): void {
  overlay.open({
    kind: "modal",
    label: "Provider login",
    content: <ProviderLoginPanel auth={createAuthPort({ client, threadId, capabilities })} />,
  });
}

/** The provider sign-in section (D3) on the settings Providers tab. */
export function ProviderLoginSection({
  client,
  threadId,
  capabilities,
}: {
  readonly client: AppClient;
  readonly threadId: ThreadId | null;
  readonly capabilities: CapabilityMap;
}) {
  const auth = useMemo(
    () => (threadId === null ? null : createAuthPort({ client, threadId, capabilities })),
    [client, threadId, capabilities],
  );
  if (auth === null) {
    return (
      <Section heading="Provider login" variant="plain">
        <p className="text-muted-foreground text-sm">Open a chat to sign in to a provider.</p>
      </Section>
    );
  }
  return <ProviderLoginPanel auth={auth} />;
}
