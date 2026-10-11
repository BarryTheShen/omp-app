import { expect, realTest, sendPrompt, startChat } from "./real-omp";

/*
 * Issue 1143: in the desktop window the default folder is the home folder. A chat there ran omp in /tmp, so
 * omp saved the session in another folder, and the sidebar listed no chats for the home folder. This spec
 * starts the server in its home folder, as the desktop does, and checks the chat is listed, also after a reload.
 */
realTest.use({ serverInHome: true });

realTest(
  "a chat in the home folder is listed in the sidebar, and stays listed after a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });

    const sessions = page.getByRole("listbox", { name: "Session list" });
    await expect(sessions.getByRole("option", { name: /ping/ })).toBeVisible();
    await expect(page.getByText("No sessions in this folder")).toHaveCount(0);

    await page.reload();
    await expect(sessions.getByRole("option", { name: /ping/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("No sessions in this folder")).toHaveCount(0);
  },
);
