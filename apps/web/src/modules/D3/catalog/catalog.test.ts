import type { AppClient } from "@omp-app/client";
import type { RedactedProviderAccount } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { createProviderCatalog, createProviderProfile } from "./catalog";

const activeAccount = {
  id: "acct-opaque",
  providerId: "provider-a",
  label: "a***@example.test",
  active: true,
  source: "oauth" as const,
  expiresAt: "2030-01-01T00:00:00.000Z",
};

function fakeClient(accounts: readonly RedactedProviderAccount[] = [activeAccount]) {
  const listProviders = vi.fn(async (_args: unknown, _options: unknown) => ({
    providers: [
      {
        id: "provider-a",
        name: "Provider A",
        available: true,
        authenticated: true,
        credentialKinds: ["oauth" as const],
        source: "agent-db" as const,
      },
    ],
  }));
  const listAccounts = vi.fn(async (_args: unknown, _options: unknown) => ({
    providerId: "provider-a",
    accounts,
  }));
  const client = { port: () => ({ listProviders, listAccounts }) } as unknown as AppClient;
  return { client, listProviders, listAccounts };
}

describe("D3 provider catalog handoff", () => {
  test("returns redacted provider and account DTOs through the typed port", async () => {
    const fake = fakeClient();
    const catalog = createProviderCatalog({
      client: fake.client,
      capabilities: {},
      threadId: "thread-a" as never,
    });
    expect(await catalog.listProviders()).toEqual({
      providers: [expect.objectContaining({ id: "provider-a" })],
    });
    expect(await catalog.listAccounts("provider-a")).toEqual([
      expect.objectContaining(activeAccount),
    ]);
    expect(fake.listProviders).toHaveBeenCalledWith({}, { signal: undefined });
    expect(fake.listAccounts).toHaveBeenCalledWith(
      { providerId: "provider-a", sessionId: "thread-a" },
      { signal: undefined },
    );
  });

  test("forwards one abort signal, omits session affinity without a thread, and preserves capabilities", async () => {
    const fake = fakeClient();
    const capabilities = { "host.provider-accounts": { state: "available", via: "host" } } as const;
    const catalog = createProviderCatalog({ client: fake.client, capabilities });
    const abort = new AbortController();
    expect(catalog.capabilities()).toBe(capabilities);
    await catalog.listProviders({ signal: abort.signal });
    await catalog.listAccounts("provider-a", { signal: abort.signal });
    expect(fake.listProviders.mock.calls[0]?.[1]).toMatchObject({ signal: abort.signal });
    expect(fake.listAccounts.mock.calls[0]).toEqual([
      { providerId: "provider-a" },
      { signal: abort.signal },
    ]);
    expect(Object.hasOwn(fake.listAccounts.mock.calls[0]?.[0] as object, "sessionId")).toBe(false);
  });

  test("maps the active account, honors a requested account, and returns null without an active account", async () => {
    const inactive: RedactedProviderAccount = {
      id: "acct-first",
      providerId: "provider-a",
      label: "a***@example.test",
      active: false,
      source: "oauth",
    };
    const fake = fakeClient([inactive, activeAccount]);
    const profile = createProviderProfile({
      client: fake.client,
      capabilities: {},
      providerId: "provider-a",
    });
    expect(await profile.getCurrent()).toMatchObject({
      accountId: activeAccount.id,
      active: true,
      expiresAt: activeAccount.expiresAt,
    });
    expect(
      await createProviderProfile({
        client: fake.client,
        capabilities: {},
        providerId: "provider-a",
        accountId: inactive.id,
      }).getCurrent(),
    ).toEqual({
      providerId: "provider-a",
      accountId: inactive.id,
      label: inactive.label,
      active: false,
      source: "oauth",
    });
    const none = createProviderProfile({
      client: fakeClient([{ ...inactive, id: "acct-none" }]).client,
      capabilities: {},
      providerId: "provider-a",
    });
    expect(await none.getCurrent()).toBeNull();
    const unsubscribe = profile.subscribe(() => undefined);
    unsubscribe();
  });
});
