import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { APP_ROOT, expect, realTest } from "./real-omp";

/**
 * Settings → Providers on real omp: a provider's stored accounts, a second account added, one signed out while the
 * other stays. A test extension adds the provider: its sign-in opens a page and asks for the email to sign in as.
 */
const EXTENSION_FILE = "provider-accounts-test.ts";
const EXTENSION_SOURCE = `export default function (pi) {
  pi.registerProvider("test-accounts", {
    oauth: {
      name: "Test Accounts",
      async login(callbacks) {
        callbacks.onAuth({ url: "https://login.example.invalid/accounts" });
        const email = await callbacks.onPrompt({ message: "Your email" });
        return { access: "access-" + email, refresh: "refresh-" + email, expires: Date.now() + 3600000, email };
      },
    },
  });
}
`;
const DATA_DIR = join(APP_ROOT, ".data");
mkdirSync(DATA_DIR, { recursive: true });
const OMP_WITH_EXTENSION = join(DATA_DIR, "omp-app-provider-accounts-omp.sh");
writeFileSync(
  OMP_WITH_EXTENSION,
  `#!/bin/sh\nexec "$@" --extension "$PI_CODING_AGENT_DIR/extensions/${EXTENSION_FILE}"\n`,
);
chmodSync(OMP_WITH_EXTENSION, 0o755);

realTest.use({
  chatWrapper: OMP_WITH_EXTENSION,
  seedExtensions: { [EXTENSION_FILE]: EXTENSION_SOURCE },
});

realTest.describe("provider accounts", () => {
  realTest.setTimeout(300_000);
  const sheet = (page: Page) => page.getByRole("dialog", { name: "Settings" });
  const signIn = (page: Page) => sheet(page).getByRole("region", { name: "Sign-in" });
  const row = (page: Page) => signIn(page).getByRole("listitem", { name: "Test Accounts" });

  async function openProviders(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(sheet(page)).toBeVisible();
    await sheet(page)
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: /^Providers/ })
      .click();
  }

  /** Signs in to Test Accounts as `email`: the dropdown, the sign-in page's link, then omp's question in the chat. */
  async function signInAs(page: Page, email: string): Promise<void> {
    await openProviders(page);
    await signIn(page).getByRole("combobox", { name: "Provider to sign in to" }).click();
    await page.getByRole("option", { name: /^Test Accounts/ }).click();
    await signIn(page).getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(signIn(page).getByRole("status")).toContainText("Test Accounts's sign-in page");
    // omp asks in the chat: the settings close to answer it.
    await page.keyboard.press("Escape");
    const question = page.getByRole("dialog", { name: "Your email" });
    await question.getByRole("textbox", { name: "Your answer" }).fill(email);
    await question.getByRole("button", { name: "Send" }).click();
    await expect(question).toBeHidden();
    await openProviders(page);
    await expect(row(page)).toContainText(email, { timeout: 30_000 });
    await page.keyboard.press("Escape");
  }

  realTest(
    "a second account is added, and signing one out leaves the other",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "New chat" })
        .click();
      await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
        "placeholder",
        "Message omp",
        { timeout: 120_000 },
      );

      await signInAs(page, "ada@example.com");
      await signInAs(page, "bo@example.com");

      await openProviders(page);
      await expect(row(page)).toContainText("ada@example.com");
      await expect(row(page)).toContainText("bo@example.com");
      // A provider signed in still offers its sign-in, for another account.
      await signIn(page).getByRole("combobox", { name: "Provider to sign in to" }).click();
      await expect(page.getByRole("option", { name: /^Test Accounts/ })).toContainText("signed in");
      await page.keyboard.press("Escape");

      await row(page).getByRole("button", { name: "Sign out ada@example.com" }).click();
      const confirm = page.getByRole("alertdialog", { name: "Sign out ada@example.com?" });
      await confirm.getByRole("button", { name: "Sign out" }).click();
      await expect(confirm).toBeHidden();
      // Signing out keeps the settings open.
      await expect(sheet(page)).toBeVisible();
      await expect(row(page)).not.toContainText("ada@example.com");
      await expect(row(page)).toContainText("bo@example.com");

      // The last account signed out: the provider is no longer signed in.
      await row(page).getByRole("button", { name: "Sign out bo@example.com" }).click();
      await page
        .getByRole("alertdialog", { name: "Sign out bo@example.com?" })
        .getByRole("button", { name: "Sign out" })
        .click();
      await expect(row(page)).toBeHidden();

      expect(realApp.problems).toEqual([]);
    },
  );
});
