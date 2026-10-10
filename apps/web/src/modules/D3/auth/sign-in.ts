import type { AppClient } from "@omp-app/client";
import {
  ProviderAccountStore,
  type ProviderCredentialKind,
  type RedactedProvider,
  type RpcSessionClient,
  RpcSessionPort,
  type ThreadId,
} from "@omp-app/contracts";
import { z } from "zod";
import type { ProviderSignIn } from "../contract";

export interface ProviderSignInFacts {
  /** The kinds of credential omp stores for the provider. */
  readonly credentialKinds: readonly ProviderCredentialKind[];
  /** Whether omp reports the provider signed in by any source, settings and environment included. */
  readonly authenticated: boolean;
}

/** A stored login wins; otherwise any key (stored, from settings, or from the environment) is an API key. */
export function providerSignIn(facts: ProviderSignInFacts): ProviderSignIn {
  if (facts.credentialKinds.includes("oauth")) return "login";
  if (facts.credentialKinds.includes("api_key") || facts.authenticated) return "api-key";
  return "none";
}

/** A sign-in in plain words, as the model list and the failure notice show it. */
export function signInLabel(signIn: ProviderSignIn): string {
  switch (signIn) {
    case "login":
      return "Signed in with your login";
    case "api-key":
      return "Uses an API key";
    case "none":
      return "Not signed in";
  }
}

/** omp's login list as its session answers `get_login_providers` (rpc-mode.ts:2314-2321). */
const LoginList = z.looseObject({
  providers: z.array(z.looseObject({ id: z.string(), authenticated: z.boolean() })),
});

/** The stored accounts, or null when they cannot be read: no sign-in is claimed for them then. */
async function storedAccounts(client: AppClient): Promise<readonly RedactedProvider[] | null> {
  try {
    return (await client.port(ProviderAccountStore).listProviders({})).providers;
  } catch {
    // The account store is unavailable here: the caller leaves those providers unlabelled.
    return null;
  }
}

/** omp's login list for the session, or null when it cannot be read: no sign-in is claimed then. */
async function loginAuthentication(
  client: AppClient,
  threadId: ThreadId,
): Promise<ReadonlyMap<string, boolean> | null> {
  try {
    const rpc = client.port(RpcSessionPort) as RpcSessionClient;
    const list = LoginList.parse(
      await rpc.send({ threadId, command: { type: "get_login_providers" } }),
    );
    return new Map(list.providers.map((provider) => [provider.id, provider.authenticated]));
  } catch {
    // The read failed (no session, or omp refused): the caller leaves those providers unlabelled.
    return null;
  }
}

/**
 * Each provider's sign-in, keyed by provider id, from the stored accounts (logins and keys the app can
 * list) and omp's login list (which also sees keys from settings and the environment). A provider neither
 * source knows is left out, so no label is shown for it. A failed read gives no label rather than a wrong
 * one, and this never rejects. With no chat open omp's login list is not asked; the stored accounts still
 * answer.
 */
export async function readProviderSignIns(options: {
  readonly client: AppClient;
  readonly threadId: ThreadId | undefined;
}): Promise<ReadonlyMap<string, ProviderSignIn>> {
  const { client, threadId } = options;
  const stored = await storedAccounts(client);
  const logins = threadId === undefined ? null : await loginAuthentication(client, threadId);
  const signIns = new Map<string, ProviderSignIn>();
  for (const provider of stored ?? []) {
    signIns.set(
      provider.id,
      providerSignIn({
        credentialKinds: provider.credentialKinds,
        authenticated: provider.authenticated || logins?.get(provider.id) === true,
      }),
    );
  }
  for (const [id, authenticated] of logins ?? []) {
    if (!signIns.has(id)) signIns.set(id, providerSignIn({ credentialKinds: [], authenticated }));
  }
  return signIns;
}
