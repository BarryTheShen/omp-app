import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest(
  "creates, chats, reloads session and draft, and captures styled themes",
  async ({ realApp }) => {
    const { folder, otherFolder } = realApp;
    const page = await realApp.open();
    const folderPicker = page.getByRole("combobox", { name: "Workspace folder" });
    await expect(folderPicker).toHaveValue(folder);
    await folderPicker.selectOption("__other__");
    await page.getByRole("textbox", { name: "Other folder path" }).fill(otherFolder);
    await page.getByRole("button", { name: "Use" }).click();
    await expect(folderPicker).toHaveValue(otherFolder);
    await expect(page.getByText("No sessions in this folder")).toBeVisible();
    await folderPicker.selectOption(folder);
    const messageInput = await startChat(page);
    // The fake provider answers a prompt containing "run_bash" with a bash tool call
    // (`echo fixture-tool`) and then "tool said: fixture-tool" (packages/omp-rpc/scripts/fake-openai-server.ts).
    const promptText = "Please run_bash and tell me what it printed.";
    await sendPrompt(messageInput, promptText);
    const toolCard = page.locator('[data-testid^="tool-card-"]');
    const userMessage = page
      .locator('[data-slot="u1-message-row"][data-role="user"]')
      .filter({ hasText: promptText });
    const assistantMessages = page.locator('[data-slot="u1-message-row"][data-role="assistant"]');
    await expect(page.getByText("tool said: fixture-tool")).toBeVisible({ timeout: 45_000 });
    await expect(userMessage).toBeVisible();
    // After sending, the cursor stays in the composer so the next message can be typed at once.
    await expect(messageInput).toBeFocused();
    await expect(toolCard.first()).toBeVisible();
    // The bash card shows the command's output (omp's bash tool result), not a waiting state.
    await expect(page.getByTestId("u3-bash-stdout")).toContainText("fixture-tool");
    await expect(page.getByText("Waiting for bash output…")).toHaveCount(0);
    await expect(assistantMessages.last()).toBeVisible();
    await expect(page.getByText("Assistant is working…")).toBeHidden({ timeout: 45_000 });
    await expect(page.getByText("Loading conversation…")).toBeHidden();
    await expect(page.getByText("Nothing here yet")).toBeVisible();
    await expect(page.getByText("No todos yet.")).toHaveCount(0);
    await messageInput.fill("draft survives reload");
    const background = await page
      .locator("[data-shell-layout]")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(background).not.toBe("rgba(0, 0, 0, 0)");
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "app-root-light.png"), fullPage: true });
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Workspace folder" })).toHaveValue(folder);
    await expect(page.getByRole("textbox", { name: "Message input" })).toHaveValue(
      "draft survives reload",
    );
    await expect(
      page
        .locator('[data-slot="u1-message-row"][data-role="user"]')
        .filter({ hasText: promptText }),
    ).toBeVisible();
    // omp hasn't titled the session, so the sidebar names it after the first prompt.
    await expect(
      page.getByRole("listbox", { name: "Session list" }).getByRole("option").first(),
    ).toContainText(promptText);
    await expect(page.locator('[data-testid^="tool-card-"]').first()).toBeVisible();
    await expect(
      page.locator('[data-slot="u1-message-row"][data-role="assistant"]').last(),
    ).toBeVisible();
    await expect(page.getByText("Loading conversation…")).toBeHidden();

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => {
          const applyDark = (): boolean => {
            const root = document.documentElement;
            if (!root) return false;
            root.classList.add("dark");
            return true;
          };
          if (applyDark()) return;
          const observer = new MutationObserver(() => {
            if (applyDark()) observer.disconnect();
          });
          observer.observe(document, { childList: true, subtree: true });
        }),
    });
    await dark.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(dark.locator("html")).toHaveClass(/dark/);
    const darkBackground = await dark
      .locator("[data-shell-layout]")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(darkBackground).not.toBe("rgba(0, 0, 0, 0)");
    // A fresh browser has no remembered thread: open the session from the sidebar, which loads
    // its history from omp.
    await dark.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(
      dark
        .locator('[data-slot="u1-message-row"][data-role="user"]')
        .filter({ hasText: promptText }),
    ).toBeVisible();
    await expect(dark.locator('[data-testid^="tool-card-"]').first()).toBeVisible();
    await waitForFiniteAnimations(dark);
    await dark.screenshot({ path: join(screenshots, "app-root-dark.png"), fullPage: true });
    await dark.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(dark);
    const narrowBackground = await dark
      .locator("[data-shell-layout]")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(narrowBackground).not.toBe("rgba(0, 0, 0, 0)");
    await dark.screenshot({ path: join(screenshots, "app-root-narrow.png"), fullPage: true });
    await dark.setViewportSize({ width: 1280, height: 900 });
    const currentThreadId = await dark.evaluate(() =>
      window.localStorage.getItem("omp.app.root.thread"),
    );
    expect(currentThreadId).not.toBeNull();
    const composer = dark.getByRole("textbox", { name: "Message input" });
    await composer.focus();
    await composer.press("Control+k");
    await expect(dark.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    const newChat = dark.getByRole("option", { name: /New chat/ });
    await expect(newChat).toBeEnabled();
    await waitForFiniteAnimations(dark);
    const paletteBackground = await dark
      .getByRole("dialog", { name: "Command palette" })
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(paletteBackground).not.toBe("rgba(0, 0, 0, 0)");
    await dark.screenshot({
      path: join(screenshots, "app-root-command-palette.png"),
      fullPage: true,
    });
    await newChat.click();
    await expect(dark.getByRole("textbox", { name: "Message input" })).toBeVisible();
    await expect
      .poll(() => dark.evaluate(() => window.localStorage.getItem("omp.app.root.thread")), {
        timeout: 45_000,
      })
      .not.toBe(currentThreadId);
    await expect(dark.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "shows omp's own question after another overlay has opened, and the answer continues the turn",
  async ({ realApp }) => {
    const page = await realApp.open();
    const messageInput = await startChat(page);

    // Opening any overlay used to rebuild and dispose the dialog host, so omp's questions never
    // appeared and the turn waited forever. Open and close the palette first.
    await messageInput.focus();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);

    // The fake provider answers a prompt containing "ask_user" with omp's ask tool, which makes
    // omp send a select request to the app (packages/omp-rpc/scripts/fake-openai-server.ts).
    await sendPrompt(messageInput, "Please ask_user which database to use.");
    const question = page.getByRole("dialog");
    try {
      await expect(question).toBeVisible({ timeout: 45_000 });
    } catch (cause) {
      // Say why, so a rare failure is diagnosable: was the prompt sent, and what is on screen?
      const sent = await page
        .locator('[data-slot="u1-message-row"][data-role="user"]')
        .filter({ hasText: "ask_user" })
        .count();
      const working = await page.getByText("Assistant is working…").count();
      const dialogs = await page.getByRole("dialog").count();
      const composer = await messageInput.inputValue();
      throw new Error(
        `omp's question never appeared: prompt in transcript=${sent}, "Assistant is working"=${working}, dialogs=${dialogs}, composer text=${JSON.stringify(composer)}`,
        { cause },
      );
    }
    await expect(question).toContainText("Which database?");
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "app-root-omp-question.png") });
    await question.getByText("SQLite").first().click();
    await question
      .getByRole("button", { name: /choose/i })
      .first()
      .click();
    await expect(page.getByText(/tool said:/)).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  },
);

realTest("lists omp's todos in the checklist panel", async ({ realApp }) => {
  const page = await realApp.open();
  const composer = await startChat(page);
  // The fake provider answers "make_todos" with omp's todo tool (one phase, two items).
  await sendPrompt(composer, "Please make_todos for the release.");
  await expect(page.getByText(/tool said:/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Assistant is working…")).toBeHidden({ timeout: 45_000 });
  await expect(page.getByText("Write the thing").first()).toBeVisible();
  await expect(page.getByText("Test the thing").first()).toBeVisible();
  await expect(page.getByText("Nothing here yet")).toHaveCount(0);
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "app-root-todos.png"), fullPage: true });
});

realTest(
  "refreshing the model connection from the palette keeps the app running and shows omp's own reply",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.focus();
    await page.keyboard.press("Control+k");
    await page.getByRole("option", { name: /Fresh connection to the model/ }).click();
    const question = page.getByRole("dialog");
    await expect(question).toContainText("Start a fresh connection to the model?");
    await question.getByRole("button", { name: "Confirm" }).click();

    // omp answers an idle `/fresh` with its own message and no `data` in the prompt response, which
    // used to crash the whole server ("Can't reach the app server"). The app now says what omp said.
    await expect(page.getByRole("status").filter({ hasText: /^omp: / })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/Can't reach the app server/)).toHaveCount(0);

    // The server is still alive and the same chat still works.
    await sendPrompt(composer, "Please run_bash and tell me what it printed.");
    await expect(page.getByText("tool said: fixture-tool")).toBeVisible({ timeout: 45_000 });
  },
);
