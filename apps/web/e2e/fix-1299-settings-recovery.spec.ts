import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const SCREENSHOTS = join(APP_ROOT, "../../.data/screenshots");

async function buildPlayground(): Promise<void> {
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fix-1299-settings-playground.tsx",
      "--outfile",
      "dist/fix-1299-settings-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = (await readdir(join(APP_ROOT, "dist/assets"))).find((file) => file.endsWith(".css"));
  if (css === undefined) throw new Error("The production build did not emit its stylesheet.");
  await mkdir(SCREENSHOTS, { recursive: true });
  await writeFile(
    join(APP_ROOT, "dist/fix-1299-settings-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>
      if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");
    </script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>Settings recovery</title>
  </head>
  <body>
    <div id="settings-recovery-root"></div>
    <script type="module" src="/fix-1299-settings-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(buildPlayground);

test("stored values the controls cannot parse show a recovery choice in light, dark and narrow layouts", async ({
  page,
}) => {
  const openAndCheck = async (
    target: typeof page,
    url: string,
    screenshot: string,
  ): Promise<void> => {
    await target.goto(url);
    const section = target.getByRole("region", { name: "Settings recovery" });
    await expect(section.getByText("This setting has an unrecognized value.")).toHaveCount(2);
    await expect(section.getByText("This field has an unrecognized value.")).toBeVisible();
    await expect(section.getByRole("button", { name: "Turn off" })).toHaveCount(2);
    await expect(section.getByRole("button", { name: "Use System" })).toBeVisible();
    const background = await target.locator("main").evaluate((main) => ({
      token: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      surface: getComputedStyle(main).backgroundColor,
    }));
    expect(background.token).not.toBe("");
    expect(background.surface).not.toBe("rgba(0, 0, 0, 0)");
    const agent = section.getByRole("group", { name: "Agent overrides" });
    if (screenshot.endsWith("-390.png")) {
      const nameInput = agent.getByRole("textbox", {
        name: "Agent overrides: Agent name 1",
      });
      const bounds = await nameInput.boundingBox();
      expect(bounds?.width).toBeGreaterThan(200);
    }
    await target.screenshot({ path: join(SCREENSHOTS, screenshot), fullPage: true });
    await agent.getByRole("button", { name: "Turn off" }).click();
    const enabled = agent.getByRole("checkbox", { name: "Agent overrides: Enabled 1" });
    await expect(enabled).toBeFocused();
  };

  await openAndCheck(page, "/fix-1299-settings-playground.html", "fix-1299-unrecognized-light.png");
  const dark = await page.context().newPage();
  await openAndCheck(
    dark,
    "/fix-1299-settings-playground.html?theme=dark",
    "fix-1299-unrecognized-dark.png",
  );
  const narrow = await page.context().newPage();
  await narrow.setViewportSize({ width: 390, height: 844 });
  await openAndCheck(narrow, "/fix-1299-settings-playground.html", "fix-1299-unrecognized-390.png");
});
