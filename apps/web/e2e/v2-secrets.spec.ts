import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startNewChat } from "./real-omp";

/**
 * Secrets for omp's Hide Secrets, on real omp: added in Settings → Providers → Secrets, a secret lands in omp's own
 * `secrets.yml` (readable by its owner only), is listed by name with the placeholder a chat's AI sees, shows its value
 * on request, and goes again; adding one turns Hide Secrets on. The message box's key button saves one and puts its
 * placeholder in the message, which the transcript shows as a lock and the name, not as an equation. A secret saved
 * outside the page (a chat's `omp-app secret add`) brings a notice whose Copy puts the value in the clipboard.
 */
const sheet = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const secrets = (page: Page) => sheet(page).getByRole("region", { name: "Secrets" });
const PLACEHOLDER = /\$\$[A-Z0-9]+_[A-Z0-9]+(?::[ULCM])?\$\$/;

const readText = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/** A new chat, ready: its message box and its placeholder ("Message omp" once the chat has opened). */
async function openChat(page: Page) {
  await startNewChat(page);
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
  return composer;
}

async function openProviders(page: Page): Promise<void> {
  await startNewChat(page);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
    "placeholder",
    "Message omp",
    { timeout: 120_000 },
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await sheet(page)
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: /^Providers/ })
    .click();
  await expect(secrets(page)).toContainText("No secrets saved yet.", { timeout: 60_000 });
}

realTest.describe("new UI: secrets the AI never sees", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a secret added in Settings is in omp's file, listed with its placeholder, shown on request, and removed",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await openProviders(page);
      const file = join(realApp.agentDir, "secrets.yml");
      await expect(secrets(page)).toContainText("Hide Secrets (under Privacy, below) is off");

      await secrets(page).getByRole("button", { name: "Add a secret" }).click();
      const dialog = page.getByRole("dialog", { name: "Add a secret" });
      // A name omp's file cannot take is refused in words that say what to fix, and nothing is saved.
      await dialog.getByLabel("Name", { exact: true }).fill("deploy token");
      await dialog.getByLabel("Value", { exact: true }).fill("tok-0123456789abcdef");
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog.getByRole("alert")).toHaveText(
        "Use letters, digits, '_', '.' and '-', starting with a letter or digit.",
      );
      await dialog.getByLabel("Name", { exact: true }).fill("DEPLOY_TOKEN");
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toHaveCount(0);

      const row = secrets(page).getByRole("listitem", { name: "DEPLOY_TOKEN" });
      await expect(row).toContainText("20 characters", { timeout: 30_000 });
      await expect(row).toContainText(/\$\$DEPLOYTOKEN_[A-Z0-9]+(?::[ULCM])?\$\$/);
      // The value is not on the page until asked for.
      await expect(sheet(page)).not.toContainText("tok-0123456789abcdef");
      await expect(secrets(page)).not.toContainText("Hide Secrets (under Privacy, below) is off");
      expect(readText(file)).toContain("content: tok-0123456789abcdef");
      expect(readText(file)).toContain("friendlyName: DEPLOY_TOKEN");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readText(join(realApp.agentDir, "config.yml"))).toMatch(
        /secrets:\s*\n\s+enabled: true/,
      );

      await row.getByRole("button", { name: "Show" }).click();
      await expect(row.getByRole("status", { name: "DEPLOY_TOKEN's value" })).toHaveText(
        "tok-0123456789abcdef",
      );
      await row.getByRole("button", { name: "Hide" }).click();
      await expect(sheet(page)).not.toContainText("tok-0123456789abcdef");

      await row.getByRole("button", { name: "Remove" }).click();
      await page
        .getByRole("alertdialog", { name: "Remove DEPLOY_TOKEN?" })
        .getByRole("button", { name: "Remove" })
        .click();
      await expect(row).toHaveCount(0);
      await expect(secrets(page)).toContainText("No secrets saved yet.");
      expect(readText(file)).not.toContain("tok-0123456789abcdef");
    },
  );

  realTest(
    "the message box's key button saves a secret and puts its placeholder in the message, sent as a message and shown as a lock and its name",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      const composer = await openChat(page);
      await page.getByRole("button", { name: "Add a secret" }).click();
      const dialog = page.getByRole("dialog", { name: "Add a secret" });
      await expect(dialog).toContainText(
        "Its placeholder goes into your message where the cursor is.",
      );
      await dialog.getByLabel("Name", { exact: true }).fill("API_KEY");
      await dialog.getByLabel("Value", { exact: true }).fill("sk-test-0123456789abcdef");
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(composer).toHaveValue(/^\$\$APIKEY_[A-Z0-9]+(?::[ULCM])?\$\$$/);
      const message = await composer.inputValue();
      expect(message).not.toContain("sk-test-0123456789abcdef");
      // In an empty box the placeholder comes first: it is a message, not Python's `$$` run.
      await expect(page.getByText("python · not in context")).toHaveCount(0);

      await sendPrompt(composer, `${message} is the key, please set it`);
      const chip = page.locator(".tr-secret").first();
      await expect(chip).toHaveText("🔒 APIKEY", { timeout: 60_000 });
      await expect(chip).toHaveAttribute("title", PLACEHOLDER);
      await expect(page.locator(".tr-md .katex")).toHaveCount(0);
      // The chat list names the chat after its first message the same way.
      await expect(page.getByRole("navigation", { name: "Chats" })).toContainText(
        "🔒 APIKEY is the key, please set it",
        { timeout: 30_000 },
      );
    },
  );

  realTest(
    "a secret saved outside the page brings a notice whose Copy puts its value in the clipboard",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await openChat(page);
      // As `… | omp-app secret add FROM_A_CHAT` in a chat's command writes it.
      writeFileSync(
        join(realApp.agentDir, "secrets.yml"),
        "- type: plain\n  content: made-by-a-command-0001\n  mode: obfuscate\n  friendlyName: FROM_A_CHAT\n",
        { mode: 0o600 },
      );
      const notice = page.getByRole("status", { name: "Saved secret" });
      await expect(notice).toContainText(
        "Saved a secret: FROM_A_CHAT. The AI only sees its placeholder.",
        { timeout: 30_000 },
      );
      await notice.getByRole("button", { name: "Copy" }).click();
      await expect(notice).toContainText("FROM_A_CHAT copied.");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        "made-by-a-command-0001",
      );
      await notice.getByRole("button", { name: "Dismiss" }).click();
      await expect(notice).toHaveCount(0);
    },
  );
});
