import { expect, realTest } from "./real-omp";

realTest.use({ seedLongTurn: 40 });

/**
 * Opening a chat is a server round trip, and its transcript is read after that. Under load either can outlast the default
 * 5 s, so every check that waits on them gets this budget.
 */
const SERVER_WAIT = { timeout: 30_000 };

realTest(
  "the real app renders a persisted long transcript with stable message rows",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const sessionList = page.getByRole("listbox", { name: "Session list" });
    await sessionList.getByRole("option", { name: /Run the long job/ }).click();

    const viewport = page.getByRole("region", { name: "Messages" });
    await expect(viewport).toHaveAttribute("aria-live", "off", SERVER_WAIT);
    await expect(viewport).toHaveAttribute("tabindex", "0");
    await expect(page.getByRole("button", { name: /earlier steps/ })).toHaveText(
      "21 earlier steps",
      SERVER_WAIT,
    );
    await expect(page.getByText("All 40 steps are done.")).toBeVisible(SERVER_WAIT);
    await expect(page.getByText("echo step-39", { exact: true })).toBeVisible(SERVER_WAIT);
    await expect(page.getByText("echo step-21", { exact: true })).toBeVisible(SERVER_WAIT);
    await expect(page.getByText("echo step-20", { exact: true })).toHaveCount(0);

    expect(realApp.problems).toEqual([]);
  },
);
