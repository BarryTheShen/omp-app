/**
 * The chat host's sign-in (SDK plan H5.2d2), end to end on the fake model provider: a test extension registers sign-in
 * providers, and the test plays the app's side (the page, the pasted code). The stored sign-in lives in the chat's
 * throwaway agent folder. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type HostRequest, SIGN_IN_ADDRESS_PROMPT } from "@omp-app/contracts/chat-host";
import { chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

/**
 * `test-login` opens a page and asks for a code; `test-secret` asks for a secret; `test-accounts` signs in the account
 * whose email is pasted, so two sign-ins store two accounts; `test-callback` waits for omp's callback on its own computer,
 * so the app asks for the address the browser ends on; `test-hang` opens its page and never ends, deaf to omp's stop.
 */
const EXTENSION = `
export default function (pi) {
  pi.registerProvider("test-login", {
    oauth: {
      name: "Test Login",
      async login(callbacks) {
        callbacks.onAuth({ url: "https://login.example.invalid/authorize", instructions: "Sign in, then paste the code" });
        callbacks.onProgress?.("Waiting for the code");
        const code = await callbacks.onPrompt({ message: "Paste the code", placeholder: "code" });
        if (code !== "good-code") throw new Error("That code is wrong");
        return "login-test-key";
      },
    },
  });
  pi.registerProvider("test-secret", {
    oauth: {
      name: "Test Secret",
      async login(callbacks) {
        callbacks.onAuth({ url: "https://login.example.invalid/secret" });
        return await callbacks.onPrompt({ message: "Your password", secret: true });
      },
    },
  });
  pi.registerProvider("test-accounts", {
    oauth: {
      name: "Test Accounts",
      async login(callbacks) {
        callbacks.onAuth({ url: "https://login.example.invalid/accounts" });
        const email = await callbacks.onPrompt({ message: "Your email" });
        return { access: "access-" + email, refresh: "refresh-" + email, expires: Date.now() + 3_600_000, email };
      },
    },
  });
  pi.registerProvider("test-callback", {
    oauth: {
      name: "Test Callback",
      async login(callbacks) {
        callbacks.onAuth({ url: "https://login.example.invalid/callback" });
        const address = await callbacks.onManualCodeInput(callbacks.signal);
        if (new URL(address).searchParams.get("code") !== "good-code") throw new Error("No good code");
        return "callback-test-key";
      },
    },
  });
  pi.registerProvider("test-hang", {
    oauth: {
      name: "Test Hang",
      async login(callbacks) {
        callbacks.onAuth({ url: "https://login.example.invalid/hang" });
        return await new Promise(() => {});
      },
    },
  });
}
`;

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

/**
 * A chat with the test providers; each question a sign-in asks gets the next of `answers` (null cancels it), the last one
 * again after.
 */
async function chatWithSignIn(command: readonly string[], ...answers: readonly (string | null)[]) {
  const chat = await chats.start(command, {
    agentFiles: { "extensions/sign-in.ts": EXTENSION },
    nativeDiscovery: true,
  });
  const asked: HostRequest[] = [];
  chat.client.onRequest(async (request) => {
    asked.push(request);
    const answer = answers[Math.min(asked.length, answers.length) - 1];
    return answer === null || answer === undefined ? { cancelled: true } : { value: answer };
  });
  await chat.client.hello;
  return { chat, asked };
}

describe("the chat host's sign-in", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: the providers are listed with whether each is signed in, and an unknown one is refused`,
      async () => {
        const { chat } = await chatWithSignIn(command, "good-code");
        const { providers } = await chat.client.request("get_login_providers", {});
        expect(providers).toContainEqual({
          id: "test-login",
          name: "Test Login",
          available: true,
          authenticated: false,
        });
        await expect(chat.client.request("login", { providerId: "nope" })).rejects.toMatchObject({
          message: "Unknown OAuth provider: nope",
        });
      },
      60_000,
    );

    programTest(
      `${program.name}: a sign-in opens its page, asks for the code, and leaves the provider signed in`,
      async () => {
        const { chat, asked } = await chatWithSignIn(command, "good-code");
        expect(await chat.client.request("login", { providerId: "test-login" })).toEqual({
          providerId: "test-login",
          cancelled: false,
        });
        expect(await chat.next((event) => event.type === "ui_open_url")).toEqual({
          type: "ui_open_url",
          url: "https://login.example.invalid/authorize",
          instructions: "Sign in, then paste the code",
        });
        expect(
          await chat.next(
            (event) => event.type === "ui_notify" && event.message === "Waiting for the code",
          ),
        ).toMatchObject({ notifyType: "info" });
        // The question carries the page, so it can be opened or copied wherever it is answered.
        expect(asked.map(({ method, params }) => ({ method, params }))).toEqual([
          {
            method: "ui.input",
            params: {
              title: "Paste the code",
              placeholder: "code",
              timeout: 600_000,
              signIn: { url: "https://login.example.invalid/authorize", name: "Test Login" },
            },
          },
        ]);
        const { providers } = await chat.client.request("get_login_providers", {});
        expect(providers.find((provider) => provider.id === "test-login")?.authenticated).toBe(
          true,
        );
      },
      60_000,
    );

    programTest(
      `${program.name}: a wrong code fails the sign-in with the provider's reason, and nothing is stored`,
      async () => {
        const { chat } = await chatWithSignIn(command, "bad-code");
        await expect(
          chat.client.request("login", { providerId: "test-login" }),
        ).rejects.toMatchObject({
          message: expect.stringContaining("That code is wrong"),
        });
        const { providers } = await chat.client.request("get_login_providers", {});
        expect(providers.find((provider) => provider.id === "test-login")?.authenticated).toBe(
          false,
        );
      },
      60_000,
    );

    programTest(
      `${program.name}: a provider that returns to omp's own computer is finished with the address the browser ends on`,
      async () => {
        const { chat, asked } = await chatWithSignIn(
          command,
          "http://localhost:1455/callback?code=good-code&state=s",
        );
        expect(await chat.client.request("login", { providerId: "test-callback" })).toEqual({
          providerId: "test-callback",
          cancelled: false,
        });
        expect(asked.map(({ method, params }) => ({ method, params }))).toEqual([
          {
            method: "ui.input",
            params: {
              title: SIGN_IN_ADDRESS_PROMPT,
              placeholder: "http://localhost:…",
              timeout: 600_000,
              signIn: { url: "https://login.example.invalid/callback", name: "Test Callback" },
            },
          },
        ]);
        const { providers } = await chat.client.request("get_login_providers", {});
        expect(providers.find((provider) => provider.id === "test-callback")?.authenticated).toBe(
          true,
        );
      },
      60_000,
    );

    programTest(
      `${program.name}: a cancelled question stops the sign-in: it answers cancelled, and nothing is stored`,
      async () => {
        const { chat, asked } = await chatWithSignIn(command, null);
        expect(await chat.client.request("login", { providerId: "test-login" })).toEqual({
          providerId: "test-login",
          cancelled: true,
        });
        expect(asked).toHaveLength(1);
        const { providers } = await chat.client.request("get_login_providers", {});
        expect(providers.find((provider) => provider.id === "test-login")?.authenticated).toBe(
          false,
        );
        // Nothing runs any more.
        expect(await chat.client.request("cancel_sign_in", {})).toEqual({ cancelled: false });
      },
      60_000,
    );

    programTest(
      `${program.name}: cancel_sign_in stops a sign-in at once, even one whose provider does not stop by itself`,
      async () => {
        const { chat } = await chatWithSignIn(command);
        const login = chat.client.request("login", { providerId: "test-hang" });
        await chat.next((event) => event.type === "ui_open_url");
        expect(await chat.client.request("cancel_sign_in", {})).toEqual({ cancelled: true });
        expect(await login).toEqual({ providerId: "test-hang", cancelled: true });
        expect(await chat.client.request("cancel_sign_in", {})).toEqual({ cancelled: false });
      },
      60_000,
    );

    programTest(
      `${program.name}: a secret is never asked for in the app`,
      async () => {
        const { chat, asked } = await chatWithSignIn(command, "hunter2");
        await expect(
          chat.client.request("login", { providerId: "test-secret" }),
        ).rejects.toMatchObject({
          message: expect.stringContaining("asks for secret input"),
        });
        expect(asked).toEqual([]);
      },
      60_000,
    );

    programTest(
      `${program.name}: two sign-ins store two accounts, and signing one out leaves the other`,
      async () => {
        const { chat } = await chatWithSignIn(command, "ada@example.com", "bo@example.com");
        await chat.client.request("login", { providerId: "test-accounts" });
        await chat.client.request("login", { providerId: "test-accounts" });
        const before = await chat.client.request("get_provider_accounts", {
          providerId: "test-accounts",
        });
        expect(before.providerId).toBe("test-accounts");
        expect(before.otherSource).toBeUndefined();
        expect(
          before.accounts
            .map(({ label, kind }) => ({ label, kind }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        ).toEqual([
          { label: "ada@example.com", kind: "oauth" },
          { label: "bo@example.com", kind: "oauth" },
        ]);
        const ada = before.accounts.find((account) => account.label === "ada@example.com");
        if (ada === undefined) throw new Error("ada@example.com is not listed");

        const after = await chat.client.request("logout_account", {
          providerId: "test-accounts",
          credentialId: ada.credentialId,
        });
        expect(after.removed).toBe(true);
        expect(after.accounts.map((account) => account.label)).toEqual(["bo@example.com"]);
        const { providers } = await chat.client.request("get_login_providers", {});
        expect(providers.find((provider) => provider.id === "test-accounts")?.authenticated).toBe(
          true,
        );

        // Signing out an account that is gone already removes nothing.
        const again = await chat.client.request("logout_account", {
          providerId: "test-accounts",
          credentialId: ada.credentialId,
        });
        expect(again.removed).toBe(false);
        expect(again.accounts.map((account) => account.label)).toEqual(["bo@example.com"]);
      },
      90_000,
    );

    programTest(
      `${program.name}: the last account signed out leaves the provider signed out; unknown providers are refused`,
      async () => {
        const { chat } = await chatWithSignIn(command, "ada@example.com");
        await chat.client.request("login", { providerId: "test-accounts" });
        const [only] = (
          await chat.client.request("get_provider_accounts", { providerId: "test-accounts" })
        ).accounts;
        if (only === undefined) throw new Error("the account is not listed");
        const after = await chat.client.request("logout_account", {
          providerId: "test-accounts",
          credentialId: only.credentialId,
        });
        expect(after).toEqual({ providerId: "test-accounts", accounts: [], removed: true });
        const { providers } = await chat.client.request("get_login_providers", {});
        expect(providers.find((provider) => provider.id === "test-accounts")?.authenticated).toBe(
          false,
        );
        await expect(
          chat.client.request("get_provider_accounts", { providerId: "nope" }),
        ).rejects.toMatchObject({ message: "Unknown OAuth provider: nope" });
        await expect(
          chat.client.request("logout_account", { providerId: "nope", credentialId: 1 }),
        ).rejects.toMatchObject({ message: "Unknown OAuth provider: nope" });
      },
      90_000,
    );
  }
});
