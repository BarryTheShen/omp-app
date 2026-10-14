/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { expect as realExpect, realTest } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");

function buildGuidedPlaygrounds(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D8/guided/playground.tsx",
      "--outfile",
      "dist/d8-4-guided-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D8/guided/real-playground.tsx",
      "--outfile",
      "dist/d8-4-guided-real-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the guided interview.");
  const writePage = (fileName: string, dark: boolean) => {
    const themeClass = dark ? ' class="dark"' : "";
    writeFileSync(
      join(DIST_ROOT, fileName),
      `<!doctype html>
<html lang="en"${themeClass}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>Guided goal playground</title>
  </head>
  <body>
    <div id="d8-4-guided-playground-root"></div>
    <script type="module" src="/d8-4-guided-playground.js"></script>
  </body>
</html>
`,
    );
  };
  writePage("d8-4-guided-playground.html", false);
  writePage("d8-4-guided-dark-playground.html", true);
}

const QUESTIONS = {
  objective: "What should omp get done?",
  success: "How will you know it is done?",
  verification: "What should omp run to check its own work?",
  attempts: "How many attempts may omp make before it stops?",
  boundaries: "What may omp change, and what must it leave alone?",
  stop: "When should omp stop and ask you?",
} as const;

const REQUIRED = [
  "objective",
  "success",
  "verification",
  "attempts",
  "boundaries",
  "stop",
] as const;
const BUDGET_QUESTION = "Token budget (optional)";
const REVIEW_TITLE = "Review your goal. Edit it if you need to, then save.";
const CREATED_NOTICE = "Goal created. omp works on it once you send a message.";

const ANSWERS = {
  objective: "Make the parser accept empty input",
  success: "bun test src/parser passes",
  verification: "bun test src/parser",
  attempts: "5 attempts",
  boundaries: "Edit src/parser only; leave the CLI alone",
  stop: "Stop and ask me before changing any public API",
} as const;

/** The objective omp expects, built the same way the app builds it for the review. */
const OBJECTIVE = [
  "## Objective",
  ANSWERS.objective,
  "",
  "## Success criteria",
  ANSWERS.success,
  "",
  "## Verification",
  ANSWERS.verification,
  "",
  "## Boundaries",
  ANSWERS.boundaries,
  "",
  "## Stop conditions",
  `Attempt cap: ${ANSWERS.attempts}`,
  ANSWERS.stop,
].join("\n");

/** A dialog's text box. Its title is also the dialog's name, so the box is found by role. */
function answerBox(page: Page, title: string) {
  return page.getByRole("textbox", { name: title, exact: true });
}

async function answerQuestion(page: Page, title: string, answer: string): Promise<void> {
  await answerBox(page, title).fill(answer);
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

/** Answers the six required questions and the budget in U4's dialogs; the review then shows the built objective. */
async function answerInterview(page: Page, budget: string): Promise<void> {
  for (const key of REQUIRED) {
    await answerQuestion(page, QUESTIONS[key], ANSWERS[key]);
  }
  await answerBox(page, BUDGET_QUESTION).fill(budget);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(answerBox(page, REVIEW_TITLE)).toHaveValue(OBJECTIVE);
}

async function expectStyles(page: Page): Promise<void> {
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  await expect(page.getByTestId("d8-4-guided-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
}

/** The page is as wide as the phone: nothing sticks out to the side and the page needs no sideways scroll. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
}

test.beforeAll(buildGuidedPlaygrounds);

test("the interview asks each question in a dialog, a blank answer is asked again, and a confirmed goal is created, in light, dark and narrow layouts", async ({
  page,
}) => {
  await page.goto("/d8-4-guided-playground.html");
  await expectStyles(page);
  await expect(page.getByRole("heading", { name: "Guided goal" })).toBeVisible();

  await page.getByRole("button", { name: "Start guided goal", exact: true }).click();
  await expect(answerBox(page, QUESTIONS.objective)).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const reAsk = `Answer this question before you continue: ${QUESTIONS.objective}`;
  await expect(answerBox(page, reAsk)).toBeVisible();

  await answerQuestion(page, reAsk, ANSWERS.objective);
  for (const key of REQUIRED.slice(1)) {
    await answerQuestion(page, QUESTIONS[key], ANSWERS[key]);
  }
  await answerBox(page, BUDGET_QUESTION).fill("5000");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(answerBox(page, REVIEW_TITLE)).toHaveValue(OBJECTIVE);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d8-4-guided-review-light.png"),
    animations: "disabled",
  });

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: CREATED_NOTICE })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message box" })).toHaveValue("");
  await expect(
    page.getByText("Loops are not available in this app yet.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Start loop" })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d8-4-guided-light.png"),
    fullPage: true,
    animations: "disabled",
  });

  const darkPage = await page.context().newPage();
  await darkPage.goto("/d8-4-guided-dark-playground.html");
  await expectStyles(darkPage);
  await darkPage.getByRole("button", { name: "Start guided goal", exact: true }).click();
  for (const key of REQUIRED) {
    await answerQuestion(darkPage, QUESTIONS[key], ANSWERS[key]);
  }
  await expect(answerBox(darkPage, BUDGET_QUESTION)).toBeVisible();
  await expect(darkPage.getByRole("dialog")).toHaveCount(1);
  await darkPage.screenshot({
    path: join(SCREENSHOT_ROOT, "d8-4-guided-dark.png"),
    animations: "disabled",
  });
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectStyles(page);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d8-4-guided-narrow.png"),
    fullPage: true,
    animations: "disabled",
  });
});

test("a question cancelled with text typed keeps the answers so far and that text in the message box", async ({
  page,
}) => {
  await page.goto("/d8-4-guided-playground.html");
  await page.getByRole("button", { name: "Start guided goal", exact: true }).click();
  await answerQuestion(page, QUESTIONS.objective, ANSWERS.objective);
  await answerQuestion(page, QUESTIONS.success, ANSWERS.success);
  await answerBox(page, QUESTIONS.verification).fill("bun test");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect(
    page.getByRole("status").filter({
      hasText: "Interview cancelled. No goal was created. Your answers are in the message box.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message box" })).toHaveValue(
    [
      `${QUESTIONS.objective}\n${ANSWERS.objective}`,
      `${QUESTIONS.success}\n${ANSWERS.success}`,
      `${QUESTIONS.verification}\nbun test`,
    ].join("\n\n"),
  );
});

test("a cancelled confirmation creates no goal and puts the reviewed goal in the message box, in a narrow layout", async ({
  page,
}) => {
  await page.goto("/d8-4-guided-playground.html");
  await page.getByRole("button", { name: "Start guided goal", exact: true }).click();
  await answerInterview(page, "");

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: "Interview cancelled. No goal was created. The goal text is in the message box.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message box" })).toHaveValue(OBJECTIVE);
  await expect(page.getByRole("button", { name: "Start again", exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectStyles(page);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "d8-4-guided-cancelled-narrow.png"),
    fullPage: true,
    animations: "disabled",
  });
});

realTest(
  "guided interview creates a goal through a real omp session with its five headings, the attempt cap and budget",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.addScriptTag({ url: "/d8-4-guided-real-playground.js" });
    try {
      await page.evaluate((folder) => {
        if (!window.mountRealGuidedGoal)
          throw new Error("The real guided goal test hook is missing.");
        window.mountRealGuidedGoal(folder);
      }, realApp.folder);
      await realExpect(page.getByRole("heading", { name: "Guided goal" })).toBeVisible({
        timeout: 60_000,
      });

      await page.getByRole("button", { name: "Start guided goal", exact: true }).click();
      await answerInterview(page, "5000");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await realExpect(page.getByRole("status").filter({ hasText: CREATED_NOTICE })).toBeVisible({
        timeout: 60_000,
      });

      const stored = await page.evaluate(() => {
        if (!window.readRealGoal) throw new Error("The real goal read hook is missing.");
        return window.readRealGoal();
      });
      realExpect(stored).not.toBeNull();
      realExpect(stored?.tokenBudget).toBe(5000);
      realExpect(stored?.objective).toBe(OBJECTIVE);
    } finally {
      await page.evaluate(() => window.unmountRealGuidedGoal?.());
    }
  },
);

realTest(
  "guided interview cancelled in a real omp session creates no goal, and start again offers the answers back",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.addScriptTag({ url: "/d8-4-guided-real-playground.js" });
    try {
      await page.evaluate((folder) => {
        if (!window.mountRealGuidedGoal)
          throw new Error("The real guided goal test hook is missing.");
        window.mountRealGuidedGoal(folder);
      }, realApp.folder);
      await realExpect(page.getByRole("heading", { name: "Guided goal" })).toBeVisible({
        timeout: 60_000,
      });

      await page.getByRole("button", { name: "Start guided goal", exact: true }).click();
      await answerInterview(page, "");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await realExpect(
        page.getByRole("status").filter({ hasText: "Interview cancelled. No goal was created." }),
      ).toBeVisible();
      const afterCancel = await page.evaluate(() => {
        if (!window.readRealGoal) throw new Error("The real goal read hook is missing.");
        return window.readRealGoal();
      });
      realExpect(afterCancel).toBeNull();
      await realExpect(page.getByRole("textbox", { name: "Message box" })).toHaveValue(OBJECTIVE);

      await page.getByRole("button", { name: "Start again", exact: true }).click();
      for (const key of REQUIRED) {
        await realExpect(answerBox(page, QUESTIONS[key])).toHaveValue(ANSWERS[key]);
        await page.getByRole("button", { name: "Save", exact: true }).click();
      }
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await realExpect(page.getByRole("status").filter({ hasText: CREATED_NOTICE })).toBeVisible({
        timeout: 60_000,
      });
      const stored = await page.evaluate(() => {
        if (!window.readRealGoal) throw new Error("The real goal read hook is missing.");
        return window.readRealGoal();
      });
      realExpect(stored?.objective).toBe(OBJECTIVE);
    } finally {
      await page.evaluate(() => window.unmountRealGuidedGoal?.());
    }
  },
);
