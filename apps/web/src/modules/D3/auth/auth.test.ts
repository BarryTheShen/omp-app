import type { AppClient } from "@omp-app/client";
import { AppFailure, type CapabilityMap, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { AUTH_CAPABILITIES } from "../contract";
import { createAuthPort } from "./auth";

const threadId = ThreadId.parse("d3-thread");

function capabilities(overrides: Partial<CapabilityMap> = {}): CapabilityMap {
  return {
    [AUTH_CAPABILITIES.getLoginProviders]: { state: "available", via: "rpc" },
    [AUTH_CAPABILITIES.login]: { state: "available", via: "rpc" },
    ...overrides,
  };
}

function fakeClient(request: (args: unknown) => Promise<unknown>): AppClient {
  return {
    port: () => ({ request }) as never,
  } as unknown as AppClient;
}

describe("D3 authentication adapter", () => {
  test("discovers typed providers and sends login through the chat session port", async () => {
    const calls: unknown[] = [];
    const client = fakeClient(async (args) => {
      calls.push(args);
      const { method } = args as { method: string };
      return method === "get_login_providers"
        ? {
            providers: [
              { id: "provider-a", name: "Provider A", available: true, authenticated: false },
            ],
          }
        : { providerId: "provider-a" };
    });
    const auth = createAuthPort({ client, threadId, capabilities: capabilities() });

    await expect(auth.getLoginProviders()).resolves.toEqual([
      { id: "provider-a", name: "Provider A", available: true, authenticated: false },
    ]);
    await expect(auth.login("provider-a")).resolves.toMatchObject({
      state: "authenticated",
      providerId: "provider-a",
    });
    expect(calls).toEqual([
      { threadId, method: "get_login_providers", params: {} },
      { threadId, method: "login", params: { providerId: "provider-a" } },
    ]);
  });

  test("gates missing capabilities and rejects unsafe provider ids without sending", async () => {
    let calls = 0;
    const client = fakeClient(async () => {
      calls += 1;
      return { providers: [] };
    });
    const auth = createAuthPort({
      client,
      threadId,
      capabilities: capabilities({
        [AUTH_CAPABILITIES.getLoginProviders]: { state: "unavailable", via: "rpc" },
      }),
    });

    await expect(auth.getLoginProviders()).rejects.toMatchObject({
      appError: { code: "unavailable", capability: AUTH_CAPABILITIES.getLoginProviders },
    });
    await expect(auth.login(" ")).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    expect(calls).toBe(0);
  });

  test("returns typed cancelled/error statuses without leaking provider error text", async () => {
    const client = fakeClient(async () => {
      throw new AppFailure({ code: "cancelled", message: "cancelled", retryable: false });
    });
    const auth = createAuthPort({ client, threadId, capabilities: capabilities() });
    await expect(auth.login("provider-a")).resolves.toMatchObject({
      state: "cancelled",
      providerId: "provider-a",
    });

    const failing = fakeClient(async () => {
      throw new Error("private provider credential detail");
    });
    await expect(
      createAuthPort({ client: failing, threadId, capabilities: capabilities() }).login(
        "provider-a",
      ),
    ).resolves.toMatchObject({ state: "error", providerId: "provider-a" });
  });
});
