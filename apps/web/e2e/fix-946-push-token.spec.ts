import { readFile } from "node:fs/promises";
import { expect, realTest, startChat } from "./real-omp";

/**
 * #946 on real omp: omp's Auto QA push token comes from PI_AUTO_QA_PUSH_TOKEN, and the push URL carries a credential
 * in its query. The Developer settings show the endpoint as hidden, and neither secret reaches the page, the debug log,
 * or the debug report the person saves. Each secret is different, and each URL parameter name gets its own run (#1020
 * review: the credential is hidden whatever its parameter is named).
 */

// Assembled at runtime so no source line looks like a real credential (the PR gate rejects those).
const TOKEN = ["tok", "x".repeat(24)].join("-");
const URL_SECRET = ["url", "y".repeat(24)].join("-");

for (const parameter of ["token", "apiKey"] as const) {
  realTest.describe(`a push URL that carries its credential in ${parameter}=`, () => {
    realTest.use({
      serverEnv: {
        PI_AUTO_QA_PUSH_TOKEN: TOKEN,
        PI_AUTO_QA_PUSH_URL: `https://qa.example.test/v1?${parameter}=${URL_SECRET}`,
      },
    });

    realTest(
      "the push token and the credential in the push URL stay out of the page, the debug log and the saved debug report",
      async ({ realApp }, testInfo) => {
        testInfo.setTimeout(240_000);
        const page = await realApp.open();
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        const settings = page.getByTestId("settings-screen");
        await expect(settings).toBeVisible();
        await settings.getByRole("button", { name: "Tools", exact: true }).click();
        await settings.getByRole("option", { name: "Tools / Developer" }).click();
        const panel = settings.getByRole("region", { name: "Tools settings", exact: true });
        await expect(panel).toBeVisible({ timeout: 20_000 });

        // The endpoint is hidden: a sentence, not a field that could show the credential.
        await expect(page.getByTestId("dev.autoqaPush.endpoint-hidden")).toHaveText(
          "Set in the environment; the value is hidden.",
        );
        const html = await page.content();
        expect(html).not.toContain(TOKEN);
        expect(html).not.toContain(URL_SECRET);
        expect(realApp.log()).not.toContain(TOKEN);
        expect(realApp.log()).not.toContain(URL_SECRET);

        // 'Save debug log' in the palette downloads the report; neither secret is in it.
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        const composer = await startChat(page);
        await composer.focus();
        await page.keyboard.press("Control+k");
        const downloadStarted = page.waitForEvent("download");
        await page.getByRole("option", { name: /Save debug log/ }).click();
        const download = await downloadStarted;
        const report = await readFile(await download.path(), "utf8");
        expect(report).toContain("omp app debug report");
        expect(report).not.toContain(TOKEN);
        expect(report).not.toContain(URL_SECRET);
        expect(realApp.log()).not.toContain(TOKEN);
        expect(realApp.log()).not.toContain(URL_SECRET);

        expect(realApp.problems).toEqual([]);
      },
    );
  });
}
