/**
 * The chat host's sign-in (SDK plan H5.2d2), end to end on the fake model provider: a test extension registers sign-in
 * providers, and the test plays the app's side (the page, the pasted code). The stored sign-in lives in the chat's
 * throwaway agent folder. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { HostRequest } from "@omp-app/contracts/chat-host";
import { chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

/** `test-login` opens a page and asks for a code; `test-secret` asks for a secret. */
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
}
`;

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

async function chatWithSignIn(command: readonly string[], code: string) {
  const chat = await chats.start(command, {
    agentFiles: { "extensions/sign-in.ts": EXTENSION },
    nativeDiscovery: true,
  });
  const asked: HostRequest[] = [];
  chat.client.onRequest(async (request) => {
    asked.push(request);
    return { value: code };
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
        expect(asked.map(({ method, params }) => ({ method, params }))).toEqual([
          {
            method: "ui.input",
            params: { title: "Paste the code", placeholder: "code", timeout: 600_000 },
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
  }
});
