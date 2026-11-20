import { withMentions } from "@omp-app/contracts";
import { expect, realTest } from "./real-omp";

const typed = "plan the @[Birthday menu](siyuan:20261118234433-s84elov) for Sunday";
const SENT = withMentions(typed, "siyuan", "A line for the model.", [
  {
    title: "Birthday menu",
    uri: "siyuan://blocks/20261118234433-s84elov",
    content: 'Red-braised beef brisket\n{: id="20261118234433-6oumwix"}',
  },
]);

realTest.use({
  seedEntries: {
    entries: [
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-11-20T18:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: SENT }],
          timestamp: 1795197600000,
        },
      },
    ],
  },
});

realTest(
  "a message that mentions a page shows what was typed and a tag for the page, never the page's content",
  async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await page.getByText("plan the", { exact: false }).first().click();
    const tags = page.getByRole("list", { name: "Sent with what it mentions" });
    await expect(tags).toContainText("Birthday menu", { timeout: 60_000 });
    await expect(page.getByText("for Sunday", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Red-braised beef brisket")).toHaveCount(0);
    await expect(page.getByText('{: id="')).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
