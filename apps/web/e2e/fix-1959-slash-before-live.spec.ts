import { holdCatalog, newHeldCatalog } from "./hold-catalog";
import { expect, realTest, startChat } from "./real-omp";

realTest("runs a slash command immediately after New chat opens", async ({ realApp }) => {
  const hold = newHeldCatalog();
  const page = await realApp.open({ beforeLoad: (target) => holdCatalog(target, hold) });
  const input = await startChat(page);
  await input.fill("/goal stable-goal");
  await input.press("Enter");

  await expect(
    page.getByText("Goal set: stable-goal. Status: Active.", { exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(input).toHaveValue("");
  hold.release();
  expect(realApp.problems).toEqual([]);
});
