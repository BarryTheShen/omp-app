import type { AppClient } from "@omp-app/client";
import { AppFailure, type CapabilityMap, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { DialogHost } from "../../U4/contract";
import { createProviderAccounts } from "./accounts";

const threadId = ThreadId.parse("d3-account-thread");
const account = {
  id: "opaque-account-id",
  providerId: "provider-a",
  label: "Redacted account",
  active: false,
  source: "oauth" as const,
};
const ready = [{ state: "available", via: "host" }] as const;

function setup({
  available = true,
  answer = true,
  failAction,
  failCode = "conflict",
}: {
  available?: boolean;
  answer?: boolean;
  failAction?: string;
  failCode?: "conflict" | "unavailable";
} = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const client = {
    port: () =>
      Object.fromEntries(
        ["listAccounts", "logout", "pin", "resetUsage"].map((method) => [
          method,
          async (args: unknown, options?: { readonly signal?: AbortSignal }) => {
            calls.push({ method, args });
            if (options?.signal?.aborted) {
              throw new AppFailure({
                code: "cancelled",
                message: "The request was cancelled.",
                retryable: false,
              });
            }
            if (method === failAction)
              throw new AppFailure({ code: failCode, message: "safe failure", retryable: true });
            if (method === "listAccounts") return { providerId: "provider-a", accounts: [account] };
            return { ok: true };
          },
        ]),
      ),
  } as unknown as AppClient;
  const confirms: Array<{ request: unknown; options: unknown }> = [];
  const dialogs = {
    confirm: async (request: unknown, options: unknown) => {
      confirms.push({ request, options });
      return answer;
    },
  } as unknown as Pick<DialogHost, "confirm">;
  const capabilities: CapabilityMap = {
    ...(available ? { "host.provider-accounts": ready[0] } : {}),
  };
  return {
    calls,
    confirms,
    controller: createProviderAccounts({
      client,
      threadId,
      providerId: "provider-a",
      capabilities,
      dialogs,
    }),
  };
}

describe("D3 provider account actions", () => {
  test("lists only redacted DTOs and supports local selection and clear", async () => {
    const { controller, calls } = setup();
    const state = await controller.reload();
    expect(state).toEqual({
      state: "ready",
      providerId: "provider-a",
      accounts: [account],
      selectedAccountId: null,
    });
    expect(calls[0]).toEqual({
      method: "listAccounts",
      args: { providerId: "provider-a", sessionId: threadId },
    });
    controller.select(account.id);
    expect(controller.getState()).toMatchObject({ selectedAccountId: account.id });
    controller.clear();
    expect(controller.getState()).toMatchObject({ selectedAccountId: null });
    expect(JSON.stringify(controller.getState())).not.toContain("token");
  });

  test("does not call the host when the account capability is unavailable", async () => {
    const { controller, calls } = setup({ available: false });
    await expect(controller.reload()).resolves.toMatchObject({
      state: "error",
      error: { code: "unavailable" },
    });
    expect(calls).toEqual([]);
  });

  test("requires app-origin confirmation and surfaces the host's unsupported usage reset", async () => {
    const { controller, calls, confirms } = setup({
      failAction: "resetUsage",
      failCode: "unavailable",
    });
    await controller.reload();
    await expect(controller.logout(account)).resolves.toBe(true);
    await expect(controller.resetUsage(account)).resolves.toBe(false);
    expect(controller.getState()).toMatchObject({ state: "empty" });
    expect(controller.actionFailure()).toMatchObject({
      action: "reset",
      error: { code: "unavailable" },
    });
    expect(confirms).toHaveLength(2);
    expect(confirms[0]?.request).toMatchObject({
      kind: "confirm",
      title: "Log out of provider",
    });
    expect(confirms[0]?.options).toMatchObject({ origin: "app", threadId });
    expect(confirms[1]?.request).toMatchObject({ kind: "confirm", title: "Reset provider usage" });
    expect(calls.map(({ method }) => method)).toEqual(["listAccounts", "logout", "resetUsage"]);
  });

  test("cancellation keeps saved accounts unchanged", async () => {
    const { controller, calls } = setup({ answer: false });
    await controller.reload();
    await expect(controller.logout(account)).resolves.toBe(false);
    expect(calls.map(({ method }) => method)).toEqual(["listAccounts"]);
  });
  test("does not retain an action failure when logout, pin, or reset is aborted", async () => {
    const actions = ["logout", "pin", "reset"] as const;
    for (const action of actions) {
      const { controller } = setup();
      await controller.reload();
      const abort = new AbortController();
      abort.abort();
      if (action === "logout") await controller.logout(account, abort.signal);
      else if (action === "pin") await controller.pin(account, abort.signal);
      else await controller.resetUsage(account, abort.signal);
      expect(controller.getState()).toMatchObject({ state: "ready" });
      expect(controller.actionFailure()).toBeNull();
    }
  });

  test("pins the account to the current session and reports mutation failures safely", async () => {
    const { controller, calls } = setup({ failAction: "pin" });
    await controller.reload();
    await controller.pin(account);
    expect(calls[1]).toEqual({
      method: "pin",
      args: { providerId: "provider-a", accountId: account.id, sessionId: threadId },
    });
    expect(controller.getState()).toMatchObject({ state: "ready" });
    expect(controller.actionFailure()).toMatchObject({
      action: "pin",
      error: { code: "conflict" },
    });
  });
});
