import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { APP_ROOT, expect, realTest, startChat } from "./real-omp";

/*
 * Issue 1381: choosing a GitHub reference typed as `pr #12` or `issue #5` leaves the typed word in front of the link,
 * so the message reads `see pr pr://12 `. The row the list offers replaces the typed word too, so the message reads
 * `see pr://12 `. The gh CLI is faked on the server's PATH: it answers the probe the app makes and the two searches.
 */

const FAKE_GH_BIN = join(APP_ROOT, ".data", "fake-gh", "bin");

// Search rows without a repository field: the list then offers the short link (pr://12, issue://5).
const FAKE_GH = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gh version 2.0.0 (fake)"
elif [ "$1:$2" = "search:prs" ]; then
  printf '%s' '[{"number":12,"title":"Fix the parser","body":"","url":"https://github.com/example/repo/pull/12","state":"open"}]'
elif [ "$1:$2" = "search:issues" ]; then
  printf '%s' '[{"number":5,"title":"Broken build","body":"","url":"https://github.com/example/repo/issues/5","state":"open"}]'
else
  echo "unexpected gh arguments" >&2
  exit 2
fi
`;

mkdirSync(FAKE_GH_BIN, { recursive: true });
writeFileSync(join(FAKE_GH_BIN, "gh"), FAKE_GH);
chmodSync(join(FAKE_GH_BIN, "gh"), 0o755);

realTest.use({ serverEnv: { PATH: `${FAKE_GH_BIN}${delimiter}${process.env.PATH ?? ""}` } });

realTest(
  "a GitHub reference typed as 'pr #12' or 'issue #5' is replaced by its link, the typed word included (issue 1381)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    await composer.fill("see pr #12");
    await expect(page.getByText("pr #12", { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByText("pr #12", { exact: true }).click();
    await expect(composer).toHaveValue("see pr://12 ");

    await composer.fill("see pr://12 and issue #5");
    await expect(page.getByText("issue #5", { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByText("issue #5", { exact: true }).click();
    await expect(composer).toHaveValue("see pr://12 and issue://5 ");
    expect(realApp.problems).toEqual([]);
  },
);
