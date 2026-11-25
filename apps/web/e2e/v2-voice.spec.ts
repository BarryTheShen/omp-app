import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Voice input (V259) in Chrome with a fake microphone (its beeps) and a fake transcription server that speaks llama.cpp's
 * chat API: the recording bar takes the box's place, Done puts the text in the box, a part that could not be transcribed
 * keeps its audio and Retry writes it out, a reload in the middle of a recording loses nothing, and the phone's bar has
 * a thumb's Done.
 */
const TEXT = "第一段 part one";

/** The fake transcription server: answers with TEXT, or with an error while `failing`. */
async function transcriber(): Promise<{
  url: string;
  set: (failing: boolean) => void;
  calls: () => number;
  close: () => Promise<void>;
}> {
  let failing = false;
  let calls = 0;
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      calls += 1;
      if (failing || !request.url?.endsWith("/chat/completions") || !body.includes("input_audio")) {
        response.writeHead(503, { "Content-Type": "text/plain" });
        response.end("model not loaded");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: `language Chinese<asr_text>${TEXT}` } }],
        }),
      );
    });
  });
  const port = await new Promise<number>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      done(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return {
    url: `http://127.0.0.1:${port}/v1`,
    set: (next) => {
      failing = next;
    },
    calls: () => calls,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/**
 * 10 s of speech-like sound for the fake microphone (Chrome loops it): a voice of drifting pitch with its harmonics,
 * loud and soft four times a second like syllables. Chrome's own fake microphone only beeps, which the server takes for
 * silence and does not transcribe; a steady tone, noise suppression may take for the room.
 */
function speechLikeWav(): string {
  const rate = 16000;
  const samples = rate * 10;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(36 + samples * 2, 4);
  bytes.write("WAVEfmt ", 8, "latin1");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "latin1");
  bytes.writeUInt32LE(samples * 2, 40);
  let phase = 0;
  for (let index = 0; index < samples; index++) {
    const time = index / rate;
    phase += (2 * Math.PI * (160 + 60 * Math.sin(2 * Math.PI * 0.7 * time))) / rate;
    const voice = Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase);
    const syllables = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * time);
    bytes.writeInt16LE(Math.round(9000 * syllables * voice), 44 + index * 2);
  }
  const file = join(tmpdir(), `omp-voice-speech-like-${process.pid}.wav`);
  writeFileSync(file, bytes);
  return file;
}

/** Chrome with a fake microphone that "speaks" (`speechLikeWav`), the microphone allowed. */
async function withMicrophone(): Promise<Browser> {
  return chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${speechLikeWav()}`,
    ],
  });
}

/** Settings → App → Voice input: a server at `url`, then voice input on. */
async function turnOn(page: Page, url: string): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const voice = settings.getByRole("region", { name: "Voice input settings" });
  await voice.getByRole("button", { name: "Add a server" }).click();
  await voice.getByRole("textbox", { name: "Name" }).fill("fake");
  await voice.getByRole("textbox", { name: "Address" }).fill(url);
  await voice.getByRole("button", { name: "Save servers" }).click();
  const on = voice.getByRole("switch", { name: "Voice input" });
  await expect(on).toBeEnabled();
  await on.click();
  await expect(on).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
}

realTest.describe("new UI voice input", () => {
  realTest.setTimeout(240_000);
  let browser: Browser;
  let context: BrowserContext;
  realTest.beforeEach(async () => {
    browser = await withMicrophone();
    context = await browser.newContext({ permissions: ["microphone"] });
  });
  realTest.afterEach(async () => {
    await context.close();
    await browser.close();
  });
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const bar = (page: Page) => page.getByRole("group", { name: "Voice input" });

  realTest(
    "the bar takes the box's place, and Done puts what was said in the box",
    async ({ realApp }) => {
      const asr = await transcriber();
      try {
        const page = await realApp.open({ path: "/", context });
        await turnOn(page, asr.url);
        await startNewChat(page);
        await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        await box(page).fill("Before:");
        await page.getByRole("button", { name: "Voice input" }).click();
        await expect(bar(page)).toBeVisible();
        await expect(box(page)).toHaveCount(0);
        await expect(bar(page).getByText("Listening…")).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(2_500);
        await bar(page).getByRole("button", { name: /^Done/ }).click();
        await expect(bar(page)).toHaveCount(0, { timeout: 60_000 });
        await expect(box(page)).toHaveValue(`Before: ${TEXT}`);
        expect(asr.calls()).toBe(1);
      } finally {
        await asr.close();
      }
    },
  );

  realTest(
    "Pause turns the microphone off and keeps the recording; Resume goes on in it, and Done puts both parts in the box",
    async ({ realApp }) => {
      const asr = await transcriber();
      try {
        const page = await realApp.open({ path: "/", context });
        await turnOn(page, asr.url);
        await startNewChat(page);
        await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        await page.getByRole("button", { name: "Voice input" }).click();
        await expect(bar(page).getByText("Listening…")).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(2_500);
        await bar(page).getByRole("button", { name: "Pause" }).click();
        await expect(bar(page).getByText(/^Paused: the microphone is off/)).toBeVisible();
        // What was said before Pause is written out while paused, and the clock holds still.
        await expect(bar(page).getByText(TEXT)).toBeVisible({ timeout: 60_000 });
        const clock = bar(page).locator("time");
        const held = await clock.textContent();
        await page.waitForTimeout(2_000);
        await expect(clock).toHaveText(held ?? "");
        expect(asr.calls()).toBe(1);

        await bar(page).getByRole("button", { name: "Resume" }).click();
        await expect(bar(page).getByRole("button", { name: "Pause" })).toBeVisible({
          timeout: 30_000,
        });
        await page.waitForTimeout(2_500);
        await bar(page).getByRole("button", { name: /^Done/ }).click();
        await expect(bar(page)).toHaveCount(0, { timeout: 60_000 });
        // One recording of two parts: the second joins the first.
        await expect(box(page)).toHaveValue(`${TEXT}${TEXT}`);
        expect(asr.calls()).toBe(2);
      } finally {
        await asr.close();
      }
    },
  );

  realTest(
    "a part the server could not transcribe stays with Retry, and Retry writes it out",
    async ({ realApp }) => {
      const asr = await transcriber();
      try {
        const page = await realApp.open({ path: "/", context });
        await turnOn(page, asr.url);
        await startNewChat(page);
        await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        asr.set(true);
        await page.getByRole("button", { name: "Voice input" }).click();
        await expect(bar(page).getByText("Listening…")).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(2_000);
        await bar(page).getByRole("button", { name: /^Done/ }).click();
        // Three tries, 2 s and 8 s apart, then the part shows as failed, the bar still up.
        await expect(bar(page).getByText(/Couldn't transcribe/)).toBeVisible({ timeout: 60_000 });
        await expect(bar(page).getByText(/Retry it, or press Done/)).toBeVisible();
        asr.set(false);
        await bar(page).getByRole("button", { name: "Retry" }).click();
        await expect(bar(page).getByText(TEXT)).toBeVisible({ timeout: 60_000 });
        await bar(page).getByRole("button", { name: /^Done/ }).click();
        await expect(box(page)).toHaveValue(TEXT, { timeout: 60_000 });
      } finally {
        await asr.close();
      }
    },
  );

  realTest(
    "a reload in the middle of a recording keeps it: its text is in Recent recordings",
    async ({ realApp }) => {
      const asr = await transcriber();
      try {
        const page = await realApp.open({ path: "/", context });
        await turnOn(page, asr.url);
        await startNewChat(page);
        await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        await page.getByRole("button", { name: "Voice input" }).click();
        await expect(bar(page).getByText("Listening…")).toBeVisible({ timeout: 30_000 });
        // The piece in the making is saved on the device every 5 s.
        await page.waitForTimeout(6_500);
        await page.reload();
        const notice = page.getByText(/A recording cut off by a reload was kept/);
        await expect(notice).toBeVisible({ timeout: 120_000 });
        await page.getByRole("button", { name: "Open", exact: true }).click();
        const recent = page.getByRole("dialog", { name: "Recent recordings" });
        await expect(recent.getByText(TEXT)).toBeVisible({ timeout: 60_000 });
        await recent.getByRole("button", { name: "Insert" }).first().click();
        await expect(recent).toHaveCount(0);
        await expect(box(page)).toHaveValue(TEXT);
      } finally {
        await asr.close();
      }
    },
  );

  realTest(
    "on a phone the mic is in Send's place on an empty box, and Done is a thumb's size",
    async ({ realApp }) => {
      const asr = await transcriber();
      const phone = await browser.newContext({
        permissions: ["microphone"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const desk = await realApp.open({ path: "/", context });
        await turnOn(desk, asr.url);
        const page = await realApp.open({ path: "/", context: phone });
        // A phone opens on a new chat.
        await expect(box(page)).toHaveAttribute("placeholder", /Fake Model/, { timeout: 120_000 });
        await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
        await page.getByRole("button", { name: "Voice input" }).tap();
        const done = bar(page).getByRole("button", { name: /^Done/ });
        await expect(done).toBeVisible();
        const size = await done.boundingBox();
        expect(size?.width ?? 0).toBeGreaterThanOrEqual(56);
        await expect(bar(page).getByText("Listening…")).toBeVisible({ timeout: 30_000 });
        // While recording (Pause shown too), every control of the bar is on the screen, Done whole.
        await expect(bar(page).getByRole("button", { name: "Pause" })).toBeVisible();
        await expect(done).toBeInViewport({ ratio: 1 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(
          0,
        );
        await page.waitForTimeout(2_000);
        await done.tap();
        await expect(box(page)).toHaveValue(TEXT, { timeout: 60_000 });
        await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
      } finally {
        await phone.close();
        await asr.close();
      }
    },
  );
});
