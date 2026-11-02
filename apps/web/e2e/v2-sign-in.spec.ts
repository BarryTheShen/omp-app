import type { Page } from "@playwright/test";
import { enableNativeSkills, expect, realTest } from "./real-omp";

/**
 * Signing in to a provider from Settings (#2784), on real omp, with providers a test extension registers:
 * `test-callback` waits for omp's callback on omp's own computer, which another device's browser cannot reach, so the
 * app asks for the address the browser ends on; `test-hang` opens its page and never ends, deaf to omp's stop.
 */
const EXTENSION = `
export default function (pi) {
  pi.registerProvider("test-callback", {
    oauth: {
      name: "Test Callback",
      async login(callbacks) {
        callbacks.onAuth({ url: "https://login.example.invalid/callback?client=app" });
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

const PAGE = "https://login.example.invalid/callback?client=app";
const sheet = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const signInSection = (page: Page) => sheet(page).getByRole("region", { name: "Sign-in" });

realTest.describe("new UI: signing in to a provider", () => {
  realTest.setTimeout(240_000);
  // The extension in the agent folder; omp loads it there only with its `native` discovery on, which the fake provider
  // turns off (`enableNativeSkills`), read by each chat as it starts.
  realTest.use({ seedExtensions: { "sign-in.ts": EXTENSION } });
  realTest.beforeEach(async ({ realApp }) => {
    await enableNativeSkills(realApp.agentDir);
  });

  /** A new chat (omp signs in inside one), then Settings → Providers, and a sign-in to `provider` started there. */
  async function startSignIn(page: Page, provider: string): Promise<void> {
    await page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: "New chat" })
      .click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "placeholder",
      "Message omp",
      {
        timeout: 120_000,
      },
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await sheet(page)
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: /^Providers/ })
      .click();
    await signInSection(page).getByRole("combobox", { name: "Provider to sign in to" }).click();
    await page.getByRole("option", { name: provider }).click();
    await signInSection(page).getByRole("button", { name: "Sign in", exact: true }).click();
  }

  realTest(
    "the page can be opened or copied, the address the browser ends on is pasted in Settings, and the provider is signed in",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await realApp.open({ path: "/", context });
      await startSignIn(page, "Test Callback");

      const section = signInSection(page);
      await expect(
        section.getByRole("link", { name: "Open Test Callback's sign-in page" }),
      ).toHaveAttribute("href", PAGE, { timeout: 60_000 });
      await section.getByRole("button", { name: "Copy link" }).click();
      await expect(section.getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PAGE);

      await section
        .getByRole("textbox", { name: "Paste its address here" })
        .fill("http://localhost:1455/callback?code=good-code&state=s");
      await section.getByRole("button", { name: "Finish sign-in" }).click();
      await expect(section.getByRole("group", { name: "Signing in to Test Callback" })).toBeHidden({
        timeout: 60_000,
      });
      await expect(section.locator("[data-tour='provider-accounts']")).toContainText(
        "Test Callback",
      );
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "Cancel sign-in stops a sign-in that never ends by itself; the chat's question has the page and its own Cancel",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startSignIn(page, "Test Hang");
      const section = signInSection(page);
      await expect(
        section.getByRole("link", { name: "Open Test Hang's sign-in page" }),
      ).toBeVisible({
        timeout: 60_000,
      });
      await section.getByRole("button", { name: "Cancel sign-in" }).click();
      await expect(section.getByText("Sign-in to Test Hang cancelled.")).toBeVisible({
        timeout: 30_000,
      });
      await expect(section.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();

      // The same question shows in the chat, with the page; its Cancel stops the sign-in too.
      await section.getByRole("combobox", { name: "Provider to sign in to" }).click();
      await page.getByRole("option", { name: "Test Callback" }).click();
      await section.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(section.getByRole("textbox", { name: "Paste its address here" })).toBeVisible({
        timeout: 60_000,
      });
      await page.keyboard.press("Escape");
      await expect(sheet(page)).toBeHidden();
      const question = page.getByRole("dialog", { name: /Paste its address here/ });
      await expect(
        question.getByRole("link", { name: "Open Test Callback's sign-in page" }),
      ).toHaveAttribute("href", PAGE);
      await expect(question.getByRole("button", { name: "Copy link" })).toBeVisible();
      await question.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(question).toBeHidden({ timeout: 30_000 });
      expect(realApp.problems).toEqual([]);
    },
  );
});
