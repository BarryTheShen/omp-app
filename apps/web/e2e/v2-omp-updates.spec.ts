import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { APP_ROOT, expect, realTest } from "./real-omp";

/**
 * Settings → App → omp, on real omp: the omp release the chats run on; and, where a job beside the app updates omp at
 * night (it writes `<app data>/omp-update.json`), what its last run came to and what it does now, a new omp ready to
 * move to, why updates stopped, and the settings it reads before anything else, which the section writes to
 * `<app data>/omp-update-settings.json` (`{ "version": 1, "enabled", "everyNights", "installHour" }`): the switch, how
 * often it looks, the install hour; and Update now, which leaves the job `<app data>/omp-update-request.json`.
 */
realTest.describe("new UI omp updates", () => {
  realTest.setTimeout(180_000);

  const settingsButton = (page: Page) =>
    page.getByRole("button", { name: "Settings", exact: true }).first();
  const section = (page: Page) =>
    page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("region", { name: "App settings" })
      .getByRole("region", { name: "omp", exact: true });
  const toggle = (page: Page) =>
    section(page).getByRole("switch", { name: "Automatic omp updates" });

  /** The omp the app pins, which its chat host is built from in every live test. */
  async function pinnedOmp(): Promise<string> {
    const manifest = JSON.parse(
      await readFile(join(APP_ROOT, "packages/server/package.json"), "utf8"),
    ) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };
    const pin = manifest.dependencies["@oh-my-pi/pi-coding-agent"];
    if (pin === undefined) throw new Error("the server pins no omp");
    return pin;
  }

  async function openOmp(page: Page): Promise<void> {
    await expect(settingsButton(page)).toBeVisible({ timeout: 120_000 });
    await settingsButton(page).click();
    await expect(section(page)).toBeVisible();
  }

  realTest(
    "names the omp the chats run on, and has no updates switch where no job updates omp",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await openOmp(page);
      await expect(section(page)).toContainText(`Your chats run on omp ${await pinnedOmp()}.`);
      await expect(toggle(page)).toHaveCount(0);
    },
  );

  realTest(
    "where a job updates omp: its last run and a ready omp; the switch writes what the job reads, and stays off after a reload",
    async ({ realApp }) => {
      const status = join(realApp.appDataDir, "omp-update.json");
      const settings = join(realApp.appDataDir, "omp-update-settings.json");
      await writeFile(
        status,
        JSON.stringify({
          version: 1,
          lastNight: {
            at: "2026-11-13T12:00:00.000Z",
            result: "No new omp to try yet: omp 18.20.0 came out less than a day ago.",
          },
          pending: "18.18.9",
        }),
      );
      const page = await realApp.open({ path: "/" });
      await openOmp(page);
      await expect(toggle(page)).toBeChecked();
      await expect(section(page)).toContainText(
        "Last run, Nov 13: No new omp to try yet: omp 18.20.0 came out less than a day ago.",
      );
      await expect(section(page)).toContainText(
        "omp 18.18.9 is ready: the app moves to it between 3 and 5 a.m.",
      );

      await toggle(page).click();
      await expect(toggle(page)).not.toBeChecked();
      await expect
        .poll(async () => JSON.parse(await readFile(settings, "utf8").catch(() => "null")))
        .toEqual({ version: 1, enabled: false, everyNights: 3, installHour: 3 });
      await expect(section(page)).toContainText(
        "omp 18.18.9 is ready, and waits until automatic updates are on.",
      );

      await page.reload();
      await openOmp(page);
      await expect(toggle(page)).not.toBeChecked();
      await toggle(page).click();
      await expect
        .poll(async () => JSON.parse(await readFile(settings, "utf8").catch(() => "null")))
        .toEqual({ version: 1, enabled: true, everyNights: 3, installHour: 3 });
    },
  );

  realTest("a job's block shows as an alert with its reason", async ({ realApp }) => {
    await writeFile(
      join(realApp.appDataDir, "omp-update.json"),
      JSON.stringify({
        version: 1,
        lastNight: {
          at: "2026-11-16T12:00:00.000Z",
          result: "Updates are stopped until you look.",
        },
        blocked: "back on 0.3.1632 after omp 18.18.9 failed its checks",
      }),
    );
    const page = await realApp.open({ path: "/" });
    await openOmp(page);
    await expect(section(page).getByRole("alert")).toHaveText(
      "Updates stopped until someone looks: back on 0.3.1632 after omp 18.18.9 failed its checks",
    );
  });

  realTest(
    "how often and from when: each menu writes what the job reads; Update now leaves the job one request and follows what it does",
    async ({ realApp }) => {
      const status = join(realApp.appDataDir, "omp-update.json");
      const settings = join(realApp.appDataDir, "omp-update-settings.json");
      const request = join(realApp.appDataDir, "omp-update-request.json");
      const lastNight = { at: "2026-11-15T06:00:00.000Z", result: "Nothing to do tonight." };
      await writeFile(status, JSON.stringify({ version: 1, lastNight }));
      const page = await realApp.open({ path: "/" });
      await openOmp(page);
      await expect(section(page)).toContainText(
        "Every third night a newer omp is tested on its own. When it passes, the app moves to it between 3 and 5 a.m., with every chat paused across the move.",
      );

      await section(page).getByRole("combobox", { name: "Look for a new omp" }).click();
      await page.getByRole("option", { name: "Every night", exact: true }).click();
      await expect
        .poll(async () => JSON.parse(await readFile(settings, "utf8").catch(() => "null")))
        .toEqual({ version: 1, enabled: true, everyNights: 1, installHour: 3 });
      await section(page).getByRole("combobox", { name: "Install from" }).click();
      await page.getByRole("option", { name: "01:00", exact: true }).click();
      await expect
        .poll(async () => JSON.parse(await readFile(settings, "utf8").catch(() => "null")))
        .toEqual({ version: 1, enabled: true, everyNights: 1, installHour: 1 });
      await expect(section(page)).toContainText(
        "Every night a newer omp is tested on its own. When it passes, the app moves to it between 1 and 3 a.m.",
      );

      const updateNow = section(page).getByRole("button", { name: "Update now" });
      await updateNow.click();
      await expect(section(page).getByRole("status")).toContainText("Update now, asked at");
      await expect(updateNow).toBeDisabled();
      const asked = JSON.parse(await readFile(request, "utf8")) as { version: number; at: string };
      expect(asked.version).toBe(1);

      // The job takes the request and says what it does; the section follows it without a reload.
      await rename(request, `${request}.taken`);
      const running =
        "Update now: looking for a new omp and testing it, since 2:14 PM. One that passes installs between 1 and 3 a.m.";
      await writeFile(status, JSON.stringify({ version: 1, lastNight, running }));
      await expect(section(page).getByRole("status")).toHaveText(running, { timeout: 30_000 });
      await expect(updateNow).toBeDisabled();
      // Done: a release waits for the install hour, also while automatic updates are off, since Update now asked for it.
      await writeFile(
        status,
        JSON.stringify({
          version: 1,
          lastNight: {
            at: "2026-11-15T21:00:00.000Z",
            result: "omp 18.21.0 is ready; the app moves to it the next night between 1 and 3 a.m.",
          },
          pending: "18.21.0",
          byRequest: true,
        }),
      );
      await expect(section(page).getByRole("status")).toHaveCount(0, { timeout: 30_000 });
      await expect(updateNow).toBeEnabled();
      await toggle(page).click();
      await expect(toggle(page)).not.toBeChecked();
      await expect(section(page)).toContainText(
        "omp 18.21.0 is ready: the app moves to it between 1 and 3 a.m.",
      );
    },
  );
});
