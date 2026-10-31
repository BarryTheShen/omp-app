import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * Device pairing in the new UI (`apps/ui/src/pairing`, Settings → App → Devices) against the real server: a page opened
 * without the launch link is a device that is not paired. It asks, and a paired page allows it after comparing 6 digits;
 * or it enters a one-time code made in Settings, typed or from the QR code's address. A removed device is refused at
 * once and pairs again.
 */
const pairingHeading = (page: Page) => page.getByRole("heading", { name: "Pair this device" });
const devices = (page: Page) => page.getByRole("region", { name: "Devices" });

async function openDevices(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(devices(page)).toBeVisible();
}

async function ask(phone: Page): Promise<string> {
  await phone.getByRole("button", { name: /^Ask (to pair|again)$/ }).click();
  const waiting = phone.getByRole("region", { name: "Waiting to be allowed" });
  const digits = waiting.getByText(/^\d{3} \d{3}$/);
  await expect(digits).toBeVisible();
  return (await digits.textContent()) ?? "";
}

realTest.describe("new UI device pairing", () => {
  realTest.setTimeout(180_000);

  realTest(
    "a device asks to pair; a paired page denies it, then allows it after the same digits; removed, it pairs again",
    async ({ realApp }) => {
      const owner = await realApp.open({ path: "/" });
      const phone = await realApp.open({ path: "/", hash: "", expectApp: false });
      await expect(pairingHeading(phone)).toBeVisible({ timeout: 30_000 });
      const name = phone.getByLabel("This device's name");
      await expect(name).not.toHaveValue("");
      await name.fill("Test phone");

      // Denied in the prompt: the device says so and may ask again.
      let digits = await ask(phone);
      const prompt = owner.getByRole("alertdialog", { name: "A device wants to pair" });
      await expect(prompt).toContainText("Test phone (browser) asks to pair");
      await expect(prompt).toContainText(digits);
      await prompt.getByRole("button", { name: "Deny" }).click();
      await expect(phone.getByRole("status")).toHaveText("The request was turned down.");
      await expect(prompt).toBeHidden();

      // Put away with Esc, the request stays in Settings → Devices, where Allow pairs it.
      digits = await ask(phone);
      await expect(prompt).toContainText(digits);
      await owner.keyboard.press("Escape");
      await expect(prompt).toBeHidden();
      await openDevices(owner);
      const asking = devices(owner).getByRole("list", { name: "Asking to pair" });
      await expect(asking).toContainText(`Test phone asks to pair, showing ${digits}`);
      await asking.getByRole("button", { name: "Allow" }).click();
      await expect(phone.locator("[data-app-root='true']")).toBeVisible({ timeout: 30_000 });
      await expect(asking).toHaveCount(0);

      const row = devices(owner).getByRole("listitem", { name: "Test phone" });
      await expect(row).toContainText("browser · Paired");
      await expect(row).toContainText("Last seen");
      await expect(row).not.toContainText("This device");
      await openDevices(phone);
      await expect(devices(phone).getByRole("listitem", { name: "Test phone" })).toContainText(
        "This device",
      );

      // Removed: its page is refused at once, and a reload shows the pairing screen.
      await row.getByRole("button", { name: "Remove" }).click();
      await owner
        .getByRole("alertdialog", { name: "Remove Test phone?" })
        .getByRole("button", { name: "Remove" })
        .click();
      await expect(row).toHaveCount(0);
      await expect(
        phone.getByText("This device is not paired with the app. Reload the page to pair it."),
      ).toBeVisible({ timeout: 30_000 });
      await phone.reload();
      await expect(pairingHeading(phone)).toBeVisible({ timeout: 30_000 });
    },
  );

  realTest(
    "a one-time code: a wrong one counts down, the QR code's address pairs at once, and the code works once",
    async ({ realApp }) => {
      const owner = await realApp.open({ path: "/" });
      await openDevices(owner);
      await expect(devices(owner)).toContainText("No device is paired yet.");
      await devices(owner).getByRole("button", { name: "Pair a new device" }).click();
      const made = devices(owner).getByRole("region", { name: "One-time code" });
      const shownCode = made.getByText(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      await expect(shownCode).toBeVisible();
      const shown = (await shownCode.textContent()) ?? "";
      await expect(
        made.getByRole("img", { name: `QR code that opens the app and pairs with code ${shown}` }),
      ).toBeVisible();

      const tablet = await realApp.open({ path: "/", hash: "", expectApp: false });
      await expect(pairingHeading(tablet)).toBeVisible({ timeout: 30_000 });
      await tablet.getByRole("button", { name: "Enter a code instead" }).click();
      const codeField = tablet.getByLabel("One-time code");
      await codeField.fill(shown === "AAAA-AAAA" ? "BBBB-BBBB" : "AAAA-AAAA");
      await tablet.getByRole("button", { name: "Pair", exact: true }).click();
      await expect(tablet.getByRole("status")).toHaveText("That code is not right: 4 tries left.");

      // What the QR code opens: the app pairs with the code and loads, and the code leaves the address.
      const scanned = await realApp.open({ path: "/", hash: `#pair=${shown.replace("-", "")}` });
      expect(new URL(scanned.url()).hash).toBe("");
      await expect(devices(owner).getByRole("list", { name: "Paired devices" }).getByRole("listitem")).toHaveCount(1);

      // Used once, the code no longer works.
      await codeField.fill(shown);
      await tablet.getByRole("button", { name: "Pair", exact: true }).click();
      await expect(tablet.getByRole("status")).toContainText("That code no longer works.");
    },
  );
});
