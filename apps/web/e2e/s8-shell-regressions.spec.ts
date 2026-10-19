import { expect, realTest, startChat } from "./real-omp";

realTest.use({ seedSessions: 12 });

async function openSessions(page: Parameters<typeof startChat>[0]): Promise<void> {
  const toggle = page.getByRole("button", { name: "Show sessions sidebar" });
  await toggle.click();
  await expect(page.getByRole("navigation", { name: "Sessions" })).toHaveAttribute(
    "data-open",
    "true",
  );
}

realTest("S8-01 dialogs retain their own Tab trap inside a narrow drawer", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSessions(page);
    await page.getByRole("textbox", { name: "Search sessions" }).press("Control+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    for (let index = 0; index < 4; index += 1) await page.keyboard.press("Tab");
    await expect(palette.locator(":focus")).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Sessions" }).locator(":focus")).toHaveCount(
      0,
    );
  } finally {
    await page.close();
  }
});

realTest("S8-02 drawer Tab stops skip roving tabindex controls", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSessions(page);
    const drawer = page.getByRole("navigation", { name: "Sessions" });
    for (let index = 0; index < 16; index += 1) await page.keyboard.press("Tab");
    await expect(drawer.locator(":focus")).toHaveCount(1);
  } finally {
    await page.close();
  }
});

realTest("S8-03 rename Escape does not close the narrow drawer", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSessions(page);
    await page
      .getByRole("button", { name: /More actions for/ })
      .first()
      .click();
    await page.getByRole("menuitem", { name: /Rename/ }).click();
    const rename = page.locator('input[aria-label^="Rename "]').first();
    await expect(rename).toBeFocused();
    await rename.press("Escape");
    await expect(page.getByRole("navigation", { name: "Sessions" })).toHaveAttribute(
      "data-open",
      "true",
    );
  } finally {
    await page.close();
  }
});

realTest("S8-04 Search sessions Escape stays in the drawer", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSessions(page);
    const search = page.getByRole("textbox", { name: "Search sessions" });
    await search.fill("Seeded chat 1");
    await search.press("Escape");
    await expect(page.getByRole("navigation", { name: "Sessions" })).toHaveAttribute(
      "data-open",
      "true",
    );
    await expect(search).toBeFocused();
  } finally {
    await page.close();
  }
});
