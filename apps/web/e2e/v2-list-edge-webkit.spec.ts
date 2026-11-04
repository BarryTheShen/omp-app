import { expect, realTest } from "./real-omp";

/**
 * The chat list's edge in WebKit, the desktop window's engine (#2826): a drag keeps up with the pointer, with thirty
 * chats in the list and a long reply on screen.
 */
realTest.use({ browserName: "webkit", channel: "", seedSessions: 30 });
realTest.describe("new UI chat list edge, WebKit", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a drag of the list's edge keeps up with the pointer and keeps the width it reached (#2826)",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await page.setViewportSize({ width: 1440, height: 900 });
      const list = page.getByRole("navigation", { name: "Chats" });
      await list
        .getByRole("button", { name: /^Seeded chat 1/ })
        .first()
        .click({ timeout: 120_000 });
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("stream_long_code");
      await box.press("Enter");
      await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0, {
        timeout: 120_000,
      });
      const edge = list.getByRole("separator", { name: "Resize the chat list" });
      const width = async (): Promise<number> => Math.round((await list.boundingBox())?.width ?? 0);
      const before = await width();
      const at = await edge.boundingBox();
      if (at === null) throw new Error("no edge");
      const x = at.x + at.width / 2;
      const y = at.y + at.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      const started = Date.now();
      // A hundred small moves, out and part of the way back, as a hand drags.
      for (let step = 1; step <= 60; step += 1) await page.mouse.move(x + step * 3, y);
      for (let step = 59; step >= 20; step -= 1) await page.mouse.move(x + step * 3, y);
      const took = Date.now() - started;
      // The column follows while the button is held.
      await expect.poll(width).toBe(before + 60);
      await page.mouse.up();
      // Each move drew the whole app again before: about 30 ms a move here, 3 to 4.5 s for these hundred.
      expect(took).toBeLessThan(1_500);
      await page.reload();
      await expect(edge).toBeVisible({ timeout: 60_000 });
      await expect.poll(width).toBe(before + 60);
      expect(realApp.problems).toEqual([]);
    },
  );
});
