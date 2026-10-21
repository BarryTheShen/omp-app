import type { Page } from "@playwright/test";
import { holdFileSearch, newHeldFileSearch } from "./hold-file-search";
import { expect, realTest, startChat } from "./real-omp";

// File search lists git files, so the chat's folder is a git repository with two files that match "RE".
realTest.use({
  seedWorkspace: { files: { "README.md": "# demo\n", "REPORT.md": "# report\n" }, gitRepo: true },
});

/**
 * The composer asks for the folder's files on its first focus, and the list keeps those files while a new query loads.
 * When the answer for "RE" replaces them, the highlight goes back to the first row by design. So the answer is held
 * until the list shows its searching line, then released, and the spec presses ArrowDown only once the answer for "RE"
 * is on screen.
 */
realTest(
  "#2235: the @ file that ArrowDown chose stays highlighted while the list is open, and Enter inserts it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const hold = newHeldFileSearch();
    const page: Page = await realApp.open({ beforeLoad: (target) => holdFileSearch(target, hold) });
    const composer = await startChat(page);
    await composer.fill("@RE");
    const list = page.getByRole("listbox", { name: "File suggestions" });
    await expect(list.getByRole("status")).toHaveText("Searching files…");
    hold.release();
    const options = list.getByRole("option");
    await expect(options).toHaveText([/README\.md/, /REPORT\.md/], { timeout: 30_000 });

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
