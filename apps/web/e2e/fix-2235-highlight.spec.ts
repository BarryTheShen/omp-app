import { expect, realTest, startChat } from "./real-omp";

// File search lists git files, so the chat's folder is a git repository with two files that match "RE".
realTest.use({
  seedWorkspace: { files: { "README.md": "# demo\n", "REPORT.md": "# report\n" }, gitRepo: true },
});

// startChat returns while the new chat is still starting, so "@RE" is typed then. When the chat's draft moved on, the
// composer used to blank for a moment, the @ list closed and reopened on its first row: ArrowDown's choice was lost.
realTest(
  "#2235: the @ file that ArrowDown chose stays highlighted while the list is open, and Enter inserts it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.fill("@RE");
    await expect(
      page.getByRole("listbox", { name: "File suggestions" }).getByRole("option"),
    ).toHaveCount(2, { timeout: 30_000 });

    await composer.press("ArrowDown");
    await expect(composer).toHaveAttribute("aria-activedescendant", /option-file:REPORT\.md$/);
    // Two seconds of samples after ArrowDown: the lost highlight came 0.1 to 1.5 s after it.
    const highlighted: string[] = [];
    for (let sample = 0; sample < 40; sample += 1) {
      highlighted.push((await composer.getAttribute("aria-activedescendant")) ?? "none");
      await page.waitForTimeout(50);
    }
    expect(highlighted.filter((id) => !id.endsWith("option-file:REPORT.md"))).toEqual([]);

    await composer.press("Enter");
    await expect(composer).toHaveValue("@REPORT.md ");
  },
);
