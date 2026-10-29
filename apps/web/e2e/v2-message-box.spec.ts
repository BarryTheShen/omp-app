import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/** The new UI's message box (`apps/ui`, under `/v2/`) on real omp: kept drafts, the queue, Stop, model and thinking. */
realTest.describe("new UI message box", () => {
  const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

  realTest.describe("with two saved chats", () => {
    realTest.use({ seedSessions: 2 });

    realTest(
      "keeps typed text across a reload, a cleared browser and a switch to another chat",
      async ({ realApp }, testInfo) => {
        testInfo.setTimeout(240_000);
        const page = await realApp.open({ path: "/v2/" });
        const text = "half a thought about the parser";

        await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
        await box(page).fill(text);
        // The app's copy is written once typing pauses.
        await page.waitForTimeout(1_500);

        await page.reload();
        await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
        await expect(box(page)).toHaveValue(text, { timeout: 60_000 });

        // Without this browser's copy, the app's copy brings it back.
        await page.evaluate(() => {
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          const request = indexedDB.deleteDatabase("omp-app-ui");
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () => resolve();
          return promise;
        });
        await page.reload();
        await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
        await expect(box(page)).toHaveValue(text, { timeout: 60_000 });

        await chats(page).getByRole("button", { name: "Seeded chat 2" }).click();
        await expect(
          page.getByRole("region", { name: "Transcript" }).getByText("Seeded chat 2"),
        ).toBeVisible({
          timeout: 60_000,
        });
        await expect(box(page)).toHaveValue("");
        await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
        await expect(box(page)).toHaveValue(text, { timeout: 60_000 });

        expect(realApp.problems).toEqual([]);
      },
    );
  });

  realTest(
    "queues a follow-up, takes it back with Edit, and Esc stops the reply and returns what was queued",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const page = await realApp.open({ path: "/v2/" });
      const followUp = "after this, write the docs";
      await chats(page).getByRole("button", { name: "New chat" }).click();
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });

      await box(page).fill("stream_steady");
      await box(page).press("Enter");
      const working = page.getByRole("status").filter({ hasText: "to stop" });
      await expect(working).toBeVisible({ timeout: 60_000 });

      await box(page).fill(followUp);
      await box(page).press("Control+Enter");
      const queued = page.getByRole("list", { name: "Queued messages" });
      await expect(queued.getByText(followUp)).toBeVisible({ timeout: 30_000 });
      await expect(box(page)).toHaveValue("");

      await queued.getByRole("button", { name: "Edit queued message" }).click();
      await expect(queued).toHaveCount(0);
      await expect(box(page)).toHaveValue(followUp);

      await box(page).press("Control+Enter");
      await expect(queued.getByText(followUp)).toBeVisible({ timeout: 30_000 });
      await box(page).press("Escape");
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
      await expect(box(page)).toHaveValue(followUp);
      await expect(queued).toHaveCount(0);
      await expect(working).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "changes the thinking level and the model from the message box",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(180_000);
      const page = await realApp.open({ path: "/v2/" });
      await chats(page).getByRole("button", { name: "New chat" }).click();
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });

      const thinking = page.getByRole("button", { name: /^Thinking: / });
      await expect(thinking).toBeVisible();
      const before = await thinking.getAttribute("aria-label");
      await thinking.click();
      await expect(thinking).not.toHaveAttribute("aria-label", before ?? "");

      const model = page.getByRole("button", { name: /^Model: / });
      await expect(model).toHaveAccessibleName("Model: Fake Model");
      await model.click();
      await page.getByRole("combobox").fill("fable");
      // omp's own catalog lists models of the same name under other providers; this one is the fake provider's.
      await page
        .getByRole("group", { name: "fake" })
        .getByRole("option", { name: /^Claude Fable 5\s*claude-fable-5$/ })
        .click();
      await expect(model).toHaveAccessibleName("Model: Claude Fable 5");

      expect(realApp.problems).toEqual([]);
    },
  );
});
