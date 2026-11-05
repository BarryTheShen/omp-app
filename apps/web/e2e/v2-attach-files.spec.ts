import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Files attached to a message (#2830), in the new UI on real omp with the fake model. Any file is uploaded to the chat's
 * own folder on the server (omp's `local://`) as it is attached, the message names it, and omp reads it there; the sent
 * message shows it as a chip that downloads it, and Edit brings it back to the box as a file, not as text.
 */

const box = (page: Page) => page.getByRole("textbox", { name: "Message" }).first();
const MARKER = "attached marker 2830\n";

/** Opens the app with each upload chunk held back 400 ms while `slow.uploads` is set, so an upload takes a moment. */
async function openApp(
  realApp: {
    open: (options: {
      path: string;
      beforeLoad: (page: Page) => Promise<unknown>;
    }) => Promise<Page>;
  },
  slow: { uploads: boolean },
): Promise<Page> {
  return realApp.open({
    path: "/",
    beforeLoad: (opened) =>
      opened.routeWebSocket(
        () => true,
        (webSocket) => {
          const server = webSocket.connectToServer();
          webSocket.onMessage((message) => {
            const chunk =
              typeof message === "string" &&
              message.includes('"port":"A1.workspaceFiles"') &&
              message.includes('"method":"writeChunk"');
            if (slow.uploads && chunk) setTimeout(() => server.send(message), 400);
            else server.send(message);
          });
          server.onMessage((message) => webSocket.send(message));
        },
      ),
  });
}

realTest(
  "a file attached with the paperclip is uploaded, omp reads it as local://, and the sent message shows it as a chip that downloads it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await openApp(realApp, { uploads: false });
    await startNewChat(page);
    await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });

    // The paperclip, on a computer too: its picker takes any kind of file.
    await expect(page.getByRole("button", { name: "Attach files" })).toBeVisible();
    const picker = page.getByLabel("Files to attach");
    expect(await picker.getAttribute("accept")).toBeNull();
    await picker.setInputFiles({
      name: "notes 1.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(MARKER),
    });
    const attached = page.getByRole("list", { name: "Attachments" });
    // Uploaded: its chip shows its size.
    await expect(attached.getByRole("listitem").filter({ hasText: "notes 1.txt" })).toContainText(
      "21 B",
      { timeout: 30_000 },
    );

    await box(page).fill('call_tool read {"path":"local://notes 1.txt"}');
    await box(page).press("Enter");
    const transcript = page.getByRole("region", { name: "Transcript" });
    // omp read the file from the chat's folder: only the file holds the marker.
    await expect(transcript.getByText(/tool said:/).first()).toBeVisible({ timeout: 60_000 });
    await expect(transcript).toContainText(MARKER.trim());
    await expect(attached).toHaveCount(0);

    // The sent message shows the file as a chip, not the paragraph that names it.
    const sentFiles = transcript.getByRole("list", { name: "Attached files" });
    const chip = sentFiles.getByRole("button", { name: "Download notes 1.txt" });
    await expect(chip).toBeVisible();
    await expect(
      transcript.getByText("Attached files (in this chat's local:// folder):"),
    ).toHaveCount(0);
    const download = page.waitForEvent("download");
    await chip.click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("notes 1.txt");
    expect(await readFile(await saved.path())).toEqual(Buffer.from(MARKER));
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "Send pressed while a file uploads sends once it is up, and Edit brings the sent message's file back as a file",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const slow = { uploads: false };
    const page = await openApp(realApp, slow);
    await startNewChat(page);
    await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });

    // Three chunks, each held back: the upload takes over a second.
    slow.uploads = true;
    await page.getByLabel("Files to attach").setInputFiles({
      name: "data.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(1200 * 1024, 7),
    });
    const attached = page.getByRole("list", { name: "Attachments" });
    const fileChip = attached.getByRole("listitem").filter({ hasText: "data.bin" });
    await expect(fileChip).toContainText("%");
    await box(page).fill("hello");
    await box(page).press("Enter");
    await expect(page.getByText("Sends once the files are uploaded")).toBeVisible();
    // Once it is up, the message goes, its file with it.
    const transcript = page.getByRole("region", { name: "Transcript" });
    await expect(transcript.getByText("pong")).toBeVisible({ timeout: 60_000 });
    slow.uploads = false;
    const sentFiles = transcript.getByRole("list", { name: "Attached files" });
    await expect(sentFiles.getByRole("button", { name: "Download data.bin" })).toBeVisible();
    await expect(attached).toHaveCount(0);

    // Edit: the text comes back as text, the file as a file in the box, as it is in the chat's folder.
    await page.getByRole("button", { name: "Edit this message" }).first().click();
    await expect(box(page)).toHaveValue("hello");
    await expect(fileChip).toContainText("1.2 MB");
    expect(realApp.problems).toEqual([]);
  },
);
