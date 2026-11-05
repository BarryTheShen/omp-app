import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/** The new UI's message box (`apps/ui`, under `/v2/`) on real omp: kept drafts, the queue, Stop, model and thinking. */
realTest.describe("new UI message box", () => {
  const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  /** The keys a new chat's pane keeps its unsent text under in this browser (IndexedDB `omp-app-ui`/`drafts`). */
  const newChatKeys = (page: Page) =>
    page.evaluate(() => {
      const { promise, resolve, reject } = Promise.withResolvers<string[]>();
      const opening = indexedDB.open("omp-app-ui");
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const reading = db.transaction("drafts").objectStore("drafts").getAllKeys();
        reading.onerror = () => reject(reading.error);
        reading.onsuccess = () => {
          db.close();
          resolve(reading.result.map(String).filter((key) => key.startsWith("new-chat:")));
        };
      };
      return promise;
    });

  realTest.describe("with two saved chats", () => {
    realTest.use({ seedSessions: 2 });

    realTest(
      "keeps typed text across a reload, a cleared browser and a switch to another chat",
      async ({ realApp }, testInfo) => {
        testInfo.setTimeout(240_000);
        const page = await realApp.open({ path: "/" });
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
    "queues a follow-up with a picture, takes it back with Edit, and Esc stops the reply and returns what was queued, picture included (#2811)",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const page = await realApp.open({ path: "/" });
      const followUp = "after this, write the docs";
      const attached = page.getByRole("list", { name: "Attachments" }).getByRole("listitem");
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });

      await box(page).fill("stream_steady");
      await box(page).press("Enter");
      const working = page.getByRole("status").filter({ hasText: "to stop" });
      await expect(working).toBeVisible({ timeout: 60_000 });

      // A computer adds a picture by dropping or pasting it on the box.
      await box(page).evaluate((input, base64) => {
        const dataTransfer = new DataTransfer();
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        dataTransfer.items.add(new File([bytes], "chart.png", { type: "image/png" }));
        input.dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
        );
      }, png);
      await expect(attached).toHaveCount(1);
      await box(page).fill(followUp);
      await box(page).press("Control+Enter");
      const queued = page.getByRole("list", { name: "Queued messages" });
      await expect(queued.getByText(followUp)).toBeVisible({ timeout: 30_000 });
      await expect(box(page)).toHaveValue("");
      await expect(attached).toHaveCount(0);

      // Its picture comes back with it, once.
      await queued.getByRole("button", { name: "Edit queued message" }).click();
      await expect(queued).toHaveCount(0);
      await expect(box(page)).toHaveValue(followUp);
      await expect(attached).toHaveCount(1);

      await box(page).press("Control+Enter");
      await expect(queued.getByText(followUp)).toBeVisible({ timeout: 30_000 });
      await expect(attached).toHaveCount(0);
      await box(page).press("Escape");
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
      await expect(box(page)).toHaveValue(followUp);
      await expect(attached).toHaveCount(1);
      await expect(queued).toHaveCount(0);
      await expect(working).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "changes the thinking level and the model from the message box",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(180_000);
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
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

  realTest(
    "a chat opened in the middle of a turn shows Stop, and Enter steers it, also when the page never saw the turn start",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const first = await realApp.open({ path: "/" });
      await startNewChat(first);
      await expect(box(first)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(first).fill("slow_tool 30");
      await box(first).press("Enter");
      await expect(first.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 60_000 });

      // Another page opens the chat while the tool runs and never gets the turn's start, as after a reload late in a
      // long turn, when the start is no longer among the events the server replays.
      const second = await realApp.open({
        path: "/",
        beforeLoad: (page) =>
          page.routeWebSocket(/\/ws/, (ws) => {
            const server = ws.connectToServer();
            ws.onMessage((message) => server.send(message));
            server.onMessage((message) => {
              if (!String(message).includes('"type":"agent_start"')) ws.send(message);
            });
          }),
      });
      await chats(second)
        .getByRole("button", { name: /^slow_tool 30/ })
        .click();
      await expect(box(second)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await expect(second.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 30_000 });
      await box(second).fill("steer from the other page");
      await box(second).press("Enter");
      await expect(
        second.getByRole("region", { name: "Transcript" }).getByText("steer from the other page"),
      ).toBeVisible({ timeout: 90_000 });

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a page that misses a turn's start and end in a reconnect still shows Stop during the turn and Send after it",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      // The server keeps a chat's last 256 events, so a page that comes back after more than that misses them, and the
      // client reports the gap. Once `lose` is set, this page's socket loses every turn's start and end.
      let lose = false;
      const page = await realApp.open({
        path: "/",
        beforeLoad: (opened) =>
          opened.routeWebSocket(/\/ws/, (ws) => {
            const server = ws.connectToServer();
            ws.onMessage((message) => server.send(message));
            server.onMessage((message) => {
              if (!(lose && /"type":"agent_(start|end)"/.test(String(message)))) ws.send(message);
            });
          }),
      });
      const stop = page.getByRole("button", { name: "Stop" });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill("slow_tool 3");
      await box(page).press("Enter");
      await expect(stop).toBeVisible({ timeout: 60_000 });
      await expect(stop).toBeHidden({ timeout: 60_000 });

      lose = true;
      await box(page).fill("slow_tool 15");
      await box(page).press("Enter");
      await expect(stop).toBeVisible({ timeout: 10_000 });
      await expect(stop).toBeHidden({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "keeps text typed in a new chat across a reload and a server restart",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      // A restart refuses the open page's connection and expires its link; the page reports both.
      realApp.allowProblem(/WebSocket|401|403|expired/i);
      const page = await realApp.open({ path: "/" });
      const context = page.context();

      // Some text right after the click, before the box says "Message omp", and more once it does.
      await startNewChat(page);
      await box(page).fill("half a thought");
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill("half a thought, finished");
      // The app's copy is written once typing pauses.
      await page.waitForTimeout(1_500);

      // The layout is kept, so the same pane comes back with its text.
      await page.reload();
      await expect(box(page)).toHaveValue("half a thought, finished", { timeout: 60_000 });

      // A restart: a page of the same browser profile, so its local copy is still there.
      await page.close();
      await realApp.restartServer();
      const again = await realApp.open({ path: "/", context });
      await expect(box(again)).toHaveValue("half a thought, finished", { timeout: 60_000 });

      // Sent, the text does not come back.
      await expect(box(again)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(again).press("Enter");
      await expect(again.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });
      await again.waitForTimeout(1_500);
      await again.reload();
      await expect(again.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
      await again.waitForTimeout(1_500);
      await expect(box(again)).toHaveValue("");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a new chat closed before sending leaves no draft behind",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open({ path: "/" });
      const tabs = page.getByRole("tablist", { name: "Workspaces" }).getByRole("tab");

      // A new chat's unsent text is kept under its pane's key.
      await startNewChat(page);
      await box(page).fill("never sent");
      await page.waitForTimeout(1_500);
      const first = await newChatKeys(page);
      expect(first).toHaveLength(1);

      // Closing that pane (Ctrl+Shift+W) removes the key.
      await page.keyboard.press("Control+Shift+O");
      // The split is a blank window: its New chat starts the chat beside.
      await startNewChat(page);
      await expect(box(page)).toHaveCount(2, { timeout: 60_000 });
      await expect(box(page).nth(1)).toBeFocused();
      await page.keyboard.press("Meta+Control+ArrowLeft");
      await expect(box(page).nth(0)).toBeFocused();
      await page.keyboard.press("Control+Shift+W");
      await expect(box(page)).toHaveCount(1, { timeout: 30_000 });
      await expect.poll(() => newChatKeys(page)).not.toContain(first[0]);
      expect(await newChatKeys(page)).toEqual([]);

      // Swap, equalize and a reload rebuild the layout with the same panes: their text stays.
      await page.keyboard.press("Control+Shift+O");
      await startNewChat(page);
      await expect(box(page)).toHaveCount(2, { timeout: 60_000 });
      await expect(box(page).nth(1)).toBeFocused();
      await box(page).nth(1).fill("still here");
      await page.waitForTimeout(1_500);
      const kept = await newChatKeys(page);
      expect(kept).toHaveLength(1);
      await page.keyboard.press("Control+Shift+F8");
      await page.keyboard.press("Meta+Control+Equal");
      await page.waitForTimeout(1_000);
      expect(await newChatKeys(page)).toEqual(kept);
      await page.reload();
      await expect(box(page)).toHaveCount(2, { timeout: 60_000 });
      await expect
        .poll(async () =>
          box(page).evaluateAll((boxes) =>
            boxes.map((each) => (each as HTMLTextAreaElement).value),
          ),
        )
        .toContain("still here");
      expect(await newChatKeys(page)).toEqual(kept);

      // Closing a tab (Ctrl+Shift+Q) removes the keys of its panes.
      await page.keyboard.press("Control+Shift+T");
      await expect(tabs).toHaveCount(2);
      await startNewChat(page);
      await expect(box(page).filter({ visible: true })).toHaveAttribute(
        "placeholder",
        "Message omp",
        {
          timeout: 120_000,
        },
      );
      await box(page).filter({ visible: true }).fill("in a tab");
      await page.waitForTimeout(1_500);
      const both = await newChatKeys(page);
      expect(both).toHaveLength(2);
      expect(both).toEqual(expect.arrayContaining(kept));
      await page.keyboard.press("Control+Shift+Q");
      await expect(tabs).toHaveCount(1);
      await expect.poll(() => newChatKeys(page)).toEqual(kept);

      // So does the close button in a pane's title bar.
      await page.keyboard.press("Control+Shift+O");
      await startNewChat(page);
      await expect(box(page)).toHaveCount(3, { timeout: 60_000 });
      const caret = page.locator("[data-chat-pane] textarea:focus");
      await expect(caret).toBeVisible();
      await caret.fill("closed from its title bar");
      await page.waitForTimeout(1_500);
      expect(await newChatKeys(page)).toHaveLength(2);
      await page
        .locator(".dv-groupview.dv-active-group")
        .getByRole("button", { name: "Close New chat" })
        .click();
      await expect(box(page)).toHaveCount(2, { timeout: 30_000 });
      await expect.poll(() => newChatKeys(page)).toEqual(kept);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "keeps typed text after the tab crashes, before the app's copy is written",
    async ({ realApp, browserName }, testInfo) => {
      realTest.skip(
        browserName !== "chromium",
        "a tab is crashed through Chromium's DevTools protocol",
      );
      testInfo.setTimeout(240_000);
      const page = await realApp.open({ path: "/" });
      const context = page.context();
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill("typed just before a crash");
      // The app's copy is written 0.8 s after typing pauses; a crash before then leaves only this browser's copy.
      await page.waitForTimeout(200);
      const devtools = await context.newCDPSession(page);
      // Chromium never answers `Page.crash`: the page dies first. Its crash event says it has.
      const crashed = page.waitForEvent("crash");
      void devtools.send("Page.crash").catch(() => undefined);
      await crashed;
      const again = await realApp.open({ path: "/", context });
      await expect(box(again)).toHaveValue("typed just before a crash", { timeout: 60_000 });
    },
  );
});
