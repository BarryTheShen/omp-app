import { expect, realTest, startChat } from "./real-omp";

const FIRST = "first message 2659";
const TYPED = "typed right after the send";

// #2659: text typed right after a New chat's first send stays in the box. It is typed with the keyboard, as a person
// types, at once and 100 ms after Enter. In that moment the New chat's own store replaced the empty source it opened
// with, the draft was built again, and the box lost what had been typed into it (#2646): on main `d08183b7a` the text
// was lost 3 of 3 times at 0 ms and 3 of 9 at 100 ms.
for (const delay of [0, 100]) {
  realTest(
    `text typed ${delay} ms after a New chat's first send stays in the box`,
    async ({ realApp }) => {
      const page = await realApp.open();
      const composer = await startChat(page);
      await composer.fill(FIRST);
      await composer.press("Enter");
      if (delay > 0) await page.waitForTimeout(delay);
      await page.keyboard.type(TYPED);
      const transcript = page.getByRole("region", { name: "Conversation transcript" });
      await expect(transcript.getByText(FIRST, { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("Conversation settled", { exact: true })).toBeVisible({
        timeout: 120_000,
      });
      const box = page.getByRole("textbox", { name: "Message input" });
      await expect(box).toHaveValue(TYPED);
      // Still so a moment later: a draft load that ends after the turn does not take the text back.
      await page.waitForTimeout(1_000);
      await expect(box).toHaveValue(TYPED);
      await expect(transcript.getByText(FIRST, { exact: true })).toHaveCount(1);
      expect(realApp.problems).toEqual([]);
    },
  );
}
