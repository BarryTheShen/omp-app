import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

const RUN = '[data-slot="u1-execution-row"]';

realTest(
  "#997 short bash output has no unnecessary block tab stops or landmarks",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "!echo hi");

    const run = page.locator(RUN);
    await expect(run).toBeVisible({ timeout: 60_000 });
    const command = page.getByRole("group", { name: "Command" });
    const output = page.getByRole("group", { name: "Output" });
    await expect(command).toBeVisible();
    await expect(output).toBeVisible();
    expect(await command.getAttribute("tabindex")).toBeNull();
    expect(await output.getAttribute("tabindex")).toBeNull();
    await expect(page.getByRole("region", { name: "Command" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Output" })).toHaveCount(0);
    await expect(command).toHaveClass(/focus-visible:ring-3/);
    await expect(output).toHaveClass(/focus-visible:ring-3/);

    await mkdir(screenshots, { recursive: true });
    await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
      path: join(screenshots, "fix-997-execution-short-light.png"),
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#997 long bash output keeps only overflowing blocks keyboard reachable",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) => target.emulateMedia({ colorScheme: "dark" }),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "!seq 1 30");

    const run = page.locator(RUN);
    await expect(run).toBeVisible({ timeout: 60_000 });
    const command = page.getByRole("group", { name: "Command" });
    const output = page.getByRole("group", { name: "Output" });
    expect((await output.innerText()).length).toBeLessThan(1_000);
    await expect(output).toHaveAttribute("tabindex", "0");
    expect(await command.getAttribute("tabindex")).toBeNull();
    await output.focus();
    await expect(output).toBeFocused();
    await expect
      .poll(() => output.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    for (let press = 0; press < 6; press += 1) await page.keyboard.press("ArrowDown");
    await expect.poll(() => output.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await mkdir(screenshots, { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
      path: join(screenshots, "fix-997-execution-long-narrow-dark.png"),
    });
    expect(realApp.problems).toEqual([]);
  },
);
