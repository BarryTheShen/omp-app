import type { AppClient } from "@omp-app/client";
import { ProviderAccountStore, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { providerSignIn, readProviderSignIns, signInLabel } from "./sign-in";

const threadId = ThreadId.parse("d3-sign-in");

/** A client whose account store and chat session answer with the given results. */
function fakeClient(accounts: unknown, login: unknown): AppClient {
  return {
    port: (port: unknown) =>
      port === ProviderAccountStore
        ? { listProviders: async () => accounts }
        : { request: async () => login },
  } as unknown as AppClient;
}

function stored(id: string, credentialKinds: string[]) {
  return {
    id,
    name: id,
    available: true,
    authenticated: credentialKinds.length > 0,
    credentialKinds,
    source: "agent-db",
  };
}

describe("providerSignIn", () => {
  test("a stored login is a login, even with an API key beside it", () => {
    expect(providerSignIn({ credentialKinds: ["oauth", "api_key"], authenticated: true })).toBe(
      "login",
    );
  });

  test("a stored or configured key is an API key; a provider with neither is none", () => {
    expect(providerSignIn({ credentialKinds: ["api_key"], authenticated: true })).toBe("api-key");
    expect(providerSignIn({ credentialKinds: [], authenticated: true })).toBe("api-key");
    expect(providerSignIn({ credentialKinds: [], authenticated: false })).toBe("none");
  });

  test("each sign-in has a plain-words label", () => {
    expect(signInLabel("login")).toBe("Signed in with your login");
    expect(signInLabel("api-key")).toBe("Uses an API key");
    expect(signInLabel("none")).toBe("Not signed in");
  });
});

describe("readProviderSignIns", () => {
  test("reads the stored accounts and omp's login list, and leaves out a provider neither knows", async () => {
    const client = fakeClient(
      { providers: [stored("openai", ["api_key"]), stored("openai-codex", ["oauth"])] },
      {
        providers: [
          { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
          { id: "google", name: "Google", available: true, authenticated: false },
        ],
      },
    );
    expect(await readProviderSignIns({ client, threadId })).toEqual(
      new Map([
        ["openai", "api-key"],
        ["openai-codex", "login"],
        ["anthropic", "api-key"],
        ["google", "none"],
      ]),
    );
  });

  test("with no chat open omp's login list is not asked, and the stored accounts still answer", async () => {
    const client = fakeClient({ providers: [stored("openai", ["oauth"])] }, undefined);
    expect(await readProviderSignIns({ client, threadId: undefined })).toEqual(
      new Map([["openai", "login"]]),
    );
  });

  test("a failed read gives no sign-ins rather than a wrong one", async () => {
    const client = {
      port: () => ({
        listProviders: async () => {
          throw new Error("unavailable");
        },
        request: async () => {
          throw new Error("unavailable");
        },
      }),
    } as unknown as AppClient;
    expect(await readProviderSignIns({ client, threadId })).toEqual(new Map());
  });

  test("a client that throws as soon as it is asked never rejects the read", async () => {
    const client = {
      port: () => {
        throw new Error("the port is not there");
      },
    } as unknown as AppClient;
    expect(await readProviderSignIns({ client, threadId })).toEqual(new Map());
  });
});
