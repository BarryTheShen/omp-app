import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { sessionBucketName } from "../../../packages/server/src/modules/A1/sessions/paths";
import type { RealApp } from "./real-omp";
import { realTest, screenshots, sendPrompt, startChat, waitForFiniteAnimations } from "./real-omp";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
async function seedOtherVersion(realApp: {
  readonly agentDir: string;
  readonly folder: string;
}): Promise<void> {
  const bucket = join(
    realApp.agentDir,
    "sessions",
    sessionBucketName(realApp.folder, { home: join(dirname(realApp.agentDir), "home") }),
  );
  await mkdir(bucket, { recursive: true });
  const parentFile = join(
    bucket,
    "2026-10-03T00-00-00-000Z_01a33333-0000-7000-8000-000000000003.jsonl",
  );
  const siblingId = "01a33333-0000-7000-8000-000000000004";
  const stamp = "2026-10-03T00:01:00.000Z";
  const lines = [
    {
      type: "session",
      version: 3,
      id: siblingId,
      timestamp: stamp,
      cwd: realApp.folder,
      title: "Other measured version",
      parentSession: parentFile,
    },
    {
      type: "message",
      id: "sibling-entry",
      parentId: null,
      timestamp: stamp,
      message: {
        role: "user",
        content: [{ type: "text", text: "Other measured version" }],
        timestamp: Date.parse(stamp),
      },
    },
  ];
  await writeFile(
    join(bucket, `${stamp.replace(/[:.]/g, "-")}_${siblingId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const timestamp = Date.UTC(2026, 9, 3, 11, 59, 0);
const answer = [
  "# Heading one",
  "",
  "## Heading two",
  "",
  "### Heading three",
  "",
  "Use `inline value` while reading this answer.",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| answer | 42 |",
  "",
  ...Array.from(
    { length: 24 },
    (_, index) => `The long answer line ${index + 1} keeps the transcript measurable.`,
  ),
].join("\n");
const entries = [
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "Measure this transcript" }],
      timestamp,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: answer }],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "stop",
      timestamp: timestamp + 1_000,
    },
  },
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "Next message spacing check" }],
      timestamp: timestamp + 1_500,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "A second measurable answer." }],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "error",
      errorMessage: "Measured seeded error",
      status: { type: "incomplete", reason: "error", error: "Measured seeded error" },
      timestamp: timestamp + 2_000,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "measure-call",
          name: "bash",
          arguments: { command: "printf measured-tool" },
        },
      ],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "toolUse",
      timestamp: timestamp + 2_500,
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "measure-call",
      toolName: "bash",
      content: [{ type: "text", text: "measured-tool\n\nWall time: 0.01 seconds" }],
      details: { wallTimeMs: 10 },
      isError: false,
      timestamp: timestamp + 2_600,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Tool output is complete." }],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "stop",
      timestamp: timestamp + 2_700,
    },
  },
];

realTest.use({ seedEntries: { entries } });
realTest.setTimeout(240_000);

async function openTheme(
  realApp: Pick<RealApp, "open">,
  theme: Theme,
  reducedMotion = false,
): Promise<Page> {
  return realApp.open({
    beforeLoad: async (page) => {
      await page.addInitScript((value: Theme) => {
        window.localStorage.setItem("omp-app.theme", value);
      }, theme);
      await page.emulateMedia({
        colorScheme: theme,
        reducedMotion: reducedMotion ? "reduce" : "no-preference",
      });
    },
  });
}

async function closeSidebars(page: Page): Promise<void> {
  for (const side of ["sessions", "panels"] as const) {
    const hide = page.getByRole("button", { name: `Hide ${side} sidebar` });
    if ((await hide.count()) > 0) await hide.first().click();
  }
}

async function openSeededChat(page: Page): Promise<void> {
  await startChat(page);
  const sessions = page.getByRole("listbox", { name: "Session list" });
  await expect(sessions).toBeVisible({ timeout: 60_000 });
  await expect(
    sessions.getByRole("option").filter({ hasText: "Other measured version" }),
  ).toBeVisible({
    timeout: 60_000,
  });
  const option = sessions
    .getByRole("option")
    .filter({ hasText: "Measure this transcript" })
    .first();
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
  await expect(
    page.locator('[data-slot="u1-message-row"][data-role="assistant"]').first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-slot="u1-message-row"][data-role="user"]').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("[data-code-view]")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-markdown-table]")).toBeVisible({ timeout: 60_000 });
}
async function startEmptyChat(page: Page): Promise<void> {
  await startChat(page);
  await expect(page.getByText("How can I help you today?", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const cssProperty = (property: string) =>
      property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const token = (name: string, property = "backgroundColor") => {
      const direct = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (property === "backgroundColor" && direct !== "") return direct;
      const probe = document.createElement("span");
      const cssName = cssProperty(property);
      if (property.startsWith("border")) {
        probe.style.borderStyle = "solid";
        probe.style.borderWidth = "1px";
      }
      probe.style.setProperty(cssName, `var(${name})`);
      document.body.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(cssName).trim();
      probe.remove();
      return value;
    };
    const canonicalColor = (value: string) => {
      const probe = document.createElement("span");
      probe.style.borderStyle = "solid";
      probe.style.borderWidth = "1px";
      probe.style.borderTopColor = value;
      document.body.append(probe);
      const canonical = getComputedStyle(probe).borderTopColor;
      probe.remove();
      return canonical;
    };
    const probeClass = (className: string, property: string) => {
      const probe = document.createElement("span");
      probe.className = className;
      probe.style.borderStyle = "solid";
      probe.style.borderWidth = "1px";
      document.body.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(cssProperty(property)).trim();
      probe.remove();
      return property.includes("Color") ? canonicalColor(value) : value;
    };
    const style = (element: Element | null) => {
      if (!(element instanceof Element)) return null;
      const computed = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        className: element.className,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        bottom: rect.bottom,
        fontSize: computed.fontSize,
        lineHeight: computed.lineHeight,
        fontWeight: computed.fontWeight,
        backgroundColor: computed.backgroundColor,
        border: computed.border,
        borderRadius: computed.borderRadius,
        borderTopColor: canonicalColor(computed.borderTopColor),
        borderBottomColor: canonicalColor(computed.borderBottomColor),
        borderLeftColor: canonicalColor(computed.borderLeftColor),
        borderLeftWidth: computed.borderLeftWidth,
        borderBottomWidth: computed.borderBottomWidth,
        marginTop: computed.marginTop,
        marginBottom: computed.marginBottom,
        columnGap: computed.columnGap,
        paddingInlineStart: computed.paddingInlineStart,
        paddingTop: computed.paddingTop,
        paddingRight: computed.paddingRight,
        paddingBottom: computed.paddingBottom,
        paddingLeft: computed.paddingLeft,
        fontFamily: computed.fontFamily,
        color: canonicalColor(computed.color),
        boxShadow: computed.boxShadow,
        animationName: computed.animationName,
      };
    };
    const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="u1-message-row"]')];
    const firstRow = rows[0];
    const assistantRow = document.querySelector<HTMLElement>(
      '[data-slot="u1-message-row"][data-role="assistant"]',
    );
    const userRow = document.querySelector<HTMLElement>(
      '[data-slot="u1-message-row"][data-role="user"]',
    );
    const userBubble =
      userRow?.querySelector<HTMLElement>('[data-message-surface="user-bubble"]') ?? null;
    const assistantText = document.querySelector<HTMLElement>(
      '[data-message-surface="assistant-text"]',
    );
    const contentWidth =
      assistantRow === null
        ? 0
        : assistantRow.getBoundingClientRect().width -
          Number.parseFloat(getComputedStyle(assistantRow).paddingLeft) -
          Number.parseFloat(getComputedStyle(assistantRow).paddingRight);
    const code = document.querySelector<HTMLElement>("[data-code-view]");
    const codeHeader = code?.firstElementChild ?? null;
    const codeLanguage = code?.querySelector("[data-code-language]") ?? null;
    const codeButton = code?.querySelector("button") ?? null;
    const codeIcon = codeButton?.querySelector("svg") ?? null;
    const codePre = code?.querySelector("pre") ?? null;
    const inlineCode = document.querySelector<HTMLElement>("[data-markdown-inline]");
    const table = document.querySelector<HTMLElement>("[data-markdown-table]");
    const tableHeader = table?.firstElementChild ?? null;
    const error = document.querySelector<HTMLElement>('[data-ending="error"]');
    const popup = document.querySelector<HTMLElement>('[aria-label="Other versions"]');
    const footerToggle = document.querySelector<HTMLElement>('[data-slot="u1-tool-calls-toggle"]');
    const actionRow = document.querySelector<HTMLElement>('[data-slot="p3-message-actions"]');
    const trace = document.querySelector<HTMLElement>('[data-slot="u3-tool-card-trigger"]');
    const headings = ["h1", "h2", "h3"].map((tag) =>
      style(assistantText?.querySelector(tag) ?? null),
    );
    const action = (role: string, word: string) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          `[data-slot="u1-message-row"][data-role="${role}"] [data-slot="p3-message-actions"] button`,
        ),
      ].find((button) => button.textContent?.includes(word)) ?? null;
    return {
      backgroundToken: token("--muted"),
      contentWidth,
      user: style(userBubble),
      assistant: style(assistantText?.querySelector("p") ?? assistantText),
      inlineCode: style(inlineCode),
      code: style(code),
      codeHeader: style(codeHeader),
      codeLanguage: style(codeLanguage),
      codeButton: style(codeButton),
      codeIcon: style(codeIcon),
      codePre: style(codePre),
      table: style(table),
      tableHeader: style(tableHeader),
      tableHeaderText: tableHeader?.textContent?.trim() ?? "",
      tableButtonCount: table?.querySelectorAll("button").length ?? 0,
      error: style(error),
      footerToggle: style(footerToggle),
      trace: style(trace),
      popup: style(popup),
      borderForeground10: probeClass("border border-foreground/10", "borderTopColor"),
      documentRadius: probeClass("rounded-document", "borderRadius"),
      surfaceRadius: probeClass("rounded-surface", "borderRadius"),
      popover: probeClass("bg-popover", "backgroundColor"),
      foreground: probeClass("text-foreground", "color"),
      codeBackgroundLight: probeClass("bg-foreground/[0.025]", "backgroundColor"),
      codeBackgroundDark: probeClass("dark:bg-foreground/[0.04]", "backgroundColor"),
      metaFontSize: probeClass("text-meta", "fontSize"),
      codeFontSize: probeClass("text-code", "fontSize"),
      mutedForeground: probeClass("text-muted-foreground", "color"),
      destructive: probeClass("text-destructive", "color"),
      destructiveBorder: probeClass("border-destructive/60", "borderLeftColor"),
      headings,
      rowGap:
        firstRow === undefined
          ? 0
          : Number.parseFloat(getComputedStyle(firstRow).paddingTop) +
            Number.parseFloat(getComputedStyle(firstRow).paddingBottom),
      edit: style(action("user", "Edit")),
      actionRow: style(actionRow),
      regenerate: style(action("assistant", "Regenerate")),
      editWordCount: document.querySelectorAll(
        '[data-slot="u1-message-row"][data-role="user"] .sr-only',
      ).length,
      regenerateWordCount: document.querySelectorAll(
        '[data-slot="u1-message-row"][data-role="assistant"] .sr-only',
      ).length,
      muted: token("--muted"),
      answerBackground: assistantText ? getComputedStyle(assistantText).backgroundColor : "",
      answerBorder: assistantText ? getComputedStyle(assistantText).border : "",
    };
  });
}

async function assertEmpty(page: Page, viewport: (typeof VIEWPORTS)[number]): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await waitForFiniteAnimations(page);
  await expect(page.locator("[data-shell-layout]")).toBeVisible();
  const greeting = await page.locator('[data-slot="u1-thread-empty"] p').evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      fontSize: computed.fontSize,
      lineHeight: computed.lineHeight,
      fontWeight: computed.fontWeight,
    };
  });
  expect(greeting.fontSize).toBe(viewport.width >= 1024 ? "28px" : "24px");
  expect(greeting.lineHeight).toBe(viewport.width >= 1024 ? "38.5px" : "33px");
  expect(greeting.fontWeight).toBe("550");
}
async function assertError(page: Page, viewport: (typeof VIEWPORTS)[number]): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await waitForFiniteAnimations(page);
  const metrics = await measure(page);
  const colorAlpha = (value: string) => value.match(/\/\s*([\d.]+)\)?$/)?.[1] ?? value;
  if (metrics.error === null) throw new Error("the seeded error ending was not rendered");
  expect(metrics.error.borderLeftWidth).toBe("2px");
  expect(colorAlpha(metrics.error.borderLeftColor)).toBe(colorAlpha(metrics.destructiveBorder));
  expect(metrics.error.paddingInlineStart).toBe("12px");
  expect(metrics.error.fontSize).toBe("13px");
  expect(metrics.error.color).toBe(metrics.destructive);
  expect(metrics.error.marginTop).toBe("8px");
}

async function assertTranscript(page: Page, viewport: (typeof VIEWPORTS)[number]): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await waitForFiniteAnimations(page);
  const initialJump = page.getByRole("button", { name: "Jump to latest message" });
  const initialViewport = page.locator('[data-slot="u1-thread-viewport"]');
  if (await initialJump.isVisible()) await initialJump.click();
  await initialViewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(initialJump).toBeHidden({ timeout: 15_000 });
  const dark = await page.locator("html").evaluate((element) => element.classList.contains("dark"));
  const metrics = await measure(page);
  const transcriptRows = [
    `Thread width (${dark ? "dark" : "light"}, ${viewport.name}) | ${viewport.width === 1280 ? "672px" : "358px"} content | ${metrics.contentWidth}px | ${metrics.contentWidth - (viewport.width === 1280 ? 672 : 358)}px`,
    `Messages (${dark ? "dark" : "light"}, ${viewport.name}) | 24px between rows | ${metrics.rowGap}px | ${metrics.rowGap - 24}px`,
    `User bubble (${dark ? "dark" : "light"}, ${viewport.name}) | max-width 80% | ${metrics.user?.width}px / ${metrics.contentWidth}px (${(((metrics.user?.width ?? 0) / (metrics.contentWidth || 358)) * 100).toFixed(1)}%); long-message cap pinned separately | short-message cap not reached`,
    `Assistant text (${dark ? "dark" : "light"}, ${viewport.name}) | 15px / 24.375px | ${metrics.assistant?.fontSize} / ${metrics.assistant?.lineHeight} | ${Number.parseFloat(metrics.assistant?.fontSize ?? "0") - 15}px, ${Number.parseFloat(metrics.assistant?.lineHeight ?? "0") - 24.375}px`,
    `Markdown headings (${dark ? "dark" : "light"}, ${viewport.name}) | h1 20/28/600; h2 18/28/600; h3 16/24/600 | ${metrics.headings.map((heading) => `${heading?.fontSize}/${heading?.lineHeight}/${heading?.fontWeight}`).join("; ")} | checked below`,
    `Inline code (${dark ? "dark" : "light"}, ${viewport.name}) | 12.75px mono | ${metrics.inlineCode?.fontSize} ${metrics.inlineCode?.fontFamily} | ${Number.parseFloat(metrics.inlineCode?.fontSize ?? "0") - 12.75}px`,
    `Code sheet (${dark ? "dark" : "light"}, ${viewport.name}) | 36px header, 14px body padding, 12.5px mono text | ${metrics.codeHeader?.height}px header, ${metrics.codePre?.paddingLeft} body padding, ${metrics.codePre?.fontSize} ${metrics.codePre?.fontFamily} | ${Number.parseFloat(metrics.codeHeader?.height.toString() ?? "0") - 36}px`,
    `Message action row (${dark ? "dark" : "light"}, ${viewport.name}) | 8px below text, 24px buttons, 6px gap | mt ${metrics.actionRow?.marginTop}; Edit ${metrics.edit?.width}×${metrics.edit?.height}px; Regenerate ${metrics.regenerate?.width}×${metrics.regenerate?.height}px; gap ${metrics.actionRow?.columnGap} | ${Number.parseFloat(metrics.actionRow?.marginTop ?? "0") - 8}px, ${Number.parseFloat(metrics.actionRow?.columnGap ?? "0") - 6}px`,
    `Trace row (${dark ? "dark" : "light"}, ${viewport.name}) | 12px mono / 19.5px | ${metrics.trace?.fontSize} ${metrics.trace?.fontFamily} / ${metrics.trace?.lineHeight} | ${Number.parseFloat(metrics.trace?.fontSize ?? "0") - 12}px, ${Number.parseFloat(metrics.trace?.lineHeight ?? "0") - 19.5}px`,
  ];
  process.stdout.write(
    `Part | Document value | Measured value | Difference\n${transcriptRows.join("\n")}\n`,
  );
  const colorAlpha = (value: string) => value.match(/\/\s*([\d.]+)\)?$/)?.[1] ?? value;
  expect(metrics.contentWidth).toBe(viewport.width === 1280 ? 672 : 358);
  const user = metrics.user;
  if (user === null) throw new Error("the real user-message bubble was not rendered");
  expect(user.backgroundColor).not.toBe("");
  expect(
    user.backgroundColor
      .replace(/(\d+(?:\.\d+)?)%/g, (_, channel: string) => (Number(channel) / 100).toString())
      .replace(/(^|[\s(])\.(\d)/g, "$10.$2"),
  ).toBe(
    metrics.muted
      .replace(/(\d+(?:\.\d+)?)%/g, (_, channel: string) => (Number(channel) / 100).toString())
      .replace(/(^|[\s(])\.(\d)/g, "$10.$2"),
  );
  expect(user.borderRadius).toBe("16px");
  expect(user.paddingTop, user.className).toBe("8px");
  expect(user.paddingRight).toBe("16px");
  expect(user.paddingBottom).toBe("8px");
  expect(user.paddingLeft).toBe("16px");
  expect(user.fontSize).toBe("15px");
  expect(user.lineHeight).toBe("22.5px");
  expect(user.width).toBeLessThanOrEqual((metrics.contentWidth || 358) * 0.8 + 1);
  expect(metrics.assistant?.fontSize).toBe("15px");
  expect(metrics.assistant?.lineHeight).toBe("24.375px");
  expect(metrics.answerBackground).toBe("rgba(0, 0, 0, 0)");
  expect(metrics.answerBorder).toMatch(/0px/);
  expect(metrics.rowGap).toBe(24);
  if (metrics.actionRow === null) throw new Error("the real message action row was not rendered");
  expect(metrics.actionRow.marginTop).toBe("8px");
  expect(metrics.actionRow.columnGap).toBe("6px");
  if (metrics.trace === null) throw new Error("the real tool trace row was not rendered");
  expect(metrics.trace.fontSize).toBe("12px");
  expect(metrics.trace.lineHeight).toBe("19.5px");
  expect(metrics.trace.fontFamily).toContain("JetBrains Mono");
  expect(metrics.inlineCode?.fontSize).toBe("12.75px");
  expect(metrics.inlineCode?.fontFamily).toContain("JetBrains Mono");
  if (metrics.code === null || metrics.codeHeader === null || metrics.codeLanguage === null) {
    throw new Error("the real code figure was not rendered");
  }
  if (metrics.codeButton === null || metrics.codeIcon === null || metrics.codePre === null) {
    throw new Error("the real code copy control was not rendered");
  }
  expect(colorAlpha(metrics.code.borderTopColor)).toBe(colorAlpha(metrics.borderForeground10));
  expect(metrics.code.borderRadius).toBe(metrics.documentRadius);
  expect(metrics.code.marginTop).toBe("12px");
  expect(metrics.code.marginBottom).toBe("12px");
  expect(metrics.code.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(metrics.codeHeader.height).toBe(36);
  expect(metrics.codeHeader.borderBottomWidth).toBe("1px");
  expect(colorAlpha(metrics.codeHeader.borderBottomColor)).toBe(
    colorAlpha(metrics.borderForeground10),
  );
  expect(metrics.codeHeader.backgroundColor).toBe(
    dark ? metrics.codeBackgroundDark : metrics.codeBackgroundLight,
  );
  expect(metrics.codeLanguage.fontSize).toBe(metrics.metaFontSize);
  expect(metrics.codeLanguage.fontFamily).toMatch(/monospace|JetBrains Mono/);
  expect(metrics.codeButton.width).toBe(24);
  expect(metrics.codeButton.height).toBe(24);
  expect(metrics.codeButton.color).toBe(metrics.mutedForeground);
  expect(metrics.codeIcon.width).toBe(14);
  expect(metrics.codeIcon.height).toBe(14);
  expect(metrics.codePre.paddingLeft).toBe("14px");
  expect(metrics.codePre.paddingRight).toBe("14px");
  expect(metrics.codePre.fontSize).toBe(metrics.codeFontSize);
  if (metrics.table === null || metrics.tableHeader === null) {
    throw new Error("the real markdown table was not rendered");
  }
  expect(colorAlpha(metrics.table.borderTopColor)).toBe(colorAlpha(metrics.borderForeground10));
  expect(metrics.table.borderRadius).toBe(metrics.documentRadius);
  expect(metrics.table.marginTop).toBe("12px");
  expect(metrics.table.marginBottom).toBe("12px");
  expect(metrics.table.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(metrics.tableHeader.height).toBe(36);
  expect(metrics.tableHeader.borderBottomColor).toBe(metrics.borderForeground10);
  expect(metrics.tableHeader.backgroundColor).toBe(
    dark ? metrics.codeBackgroundDark : metrics.codeBackgroundLight,
  );
  expect(metrics.tableHeaderText).toBe("table");
  expect(metrics.tableButtonCount).toBe(0);
  if (metrics.footerToggle === null) throw new Error("the footer tool toggle was not rendered");
  expect(metrics.footerToggle.height).toBe(28);
  expect(metrics.footerToggle.paddingLeft).toBe("8px");
  expect(metrics.footerToggle.paddingRight).toBe("8px");
  expect(metrics.footerToggle.fontSize).toBe("12px");
  expect(metrics.footerToggle.borderTopColor).toBe("rgba(0, 0, 0, 0)");
  expect(metrics.footerToggle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(metrics.footerToggle.color).toBe(metrics.mutedForeground);
  await page.locator('[data-slot="u1-tool-calls-toggle"]').hover();
  await expect
    .poll(() =>
      page
        .locator('[data-slot="u1-tool-calls-toggle"]')
        .evaluate((element) => getComputedStyle(element).color),
    )
    .toBe(metrics.foreground);
  const versions = page.getByRole("button", { name: "Other versions" });
  await expect(versions).toBeVisible();
  await versions.click();
  const popup = page.getByRole("list", { name: "Other versions" });
  await expect(popup).toBeVisible();
  const popupMetrics = await popup.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      radius: computed.borderRadius,
      borderTopColor: computed.borderTopColor,
      borderTopWidth: computed.borderTopWidth,
      boxShadow: computed.boxShadow,
      backgroundColor: computed.backgroundColor,
    };
  });
  expect(popupMetrics.radius).toBe(metrics.surfaceRadius);
  expect(colorAlpha(popupMetrics.borderTopColor)).toBe(colorAlpha(metrics.borderForeground10));
  expect(popupMetrics.borderTopWidth).toBe("1px");
  expect(popupMetrics.boxShadow).toBe("none");
  expect(popupMetrics.backgroundColor).toBe(metrics.popover);
  await versions.click();
  expect(metrics.headings[0]?.fontSize).toBe("20px");
  expect(metrics.headings[0]?.lineHeight).toBe("28px");
  expect(metrics.headings[0]?.fontWeight).toBe("600");
  expect(metrics.headings[1]?.fontSize).toBe("18px");
  expect(metrics.headings[1]?.lineHeight).toBe("28px");
  expect(metrics.headings[1]?.fontWeight).toBe("600");
  expect(metrics.headings[2]?.fontSize).toBe("16px");
  expect(metrics.headings[2]?.lineHeight).toBe("24px");
  expect(metrics.headings[2]?.fontWeight).toBe("600");
  if (metrics.edit === null) throw new Error("the real Edit action was not rendered");
  if (metrics.regenerate === null) throw new Error("the real Regenerate action was not rendered");
  expect(metrics.edit.width).toBe(24);
  expect(metrics.edit.height).toBe(24);
  expect(metrics.regenerate.width).toBe(24);
  expect(metrics.regenerate.height).toBe(24);
  expect(metrics.editWordCount).toBeGreaterThan(0);
  expect(metrics.regenerateWordCount).toBeGreaterThan(0);

  const jump = page.getByRole("button", { name: "Jump to latest message" });
  const viewportElement = page.locator('[data-slot="u1-thread-viewport"]');
  await viewportElement.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(jump).toBeHidden({ timeout: 15_000 });
  await viewportElement.hover();
  await page.mouse.wheel(0, -1000);
  await expect(jump).toBeVisible({ timeout: 15_000 });
  const jumpMetrics = await jump.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      icon: element.querySelector("svg")?.getBoundingClientRect().width ?? 0,
    };
  });
  expect(jumpMetrics).toEqual({ width: 32, height: 32, icon: 16 });
  await viewportElement.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(jump).toBeHidden({ timeout: 15_000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

realTest(
  "Step 4 transcript grammar measures in both themes and both viewports",
  async ({ realApp }, testInfo) => {
    await seedOtherVersion(realApp);
    await mkdir(screenshots, { recursive: true });
    const shouldCapture = testInfo.repeatEachIndex === 0;
    for (const theme of THEMES) {
      const emptyPage = await openTheme(realApp, theme);
      try {
        await startEmptyChat(emptyPage);
        for (const viewport of VIEWPORTS) {
          await assertEmpty(emptyPage, viewport);
          if (shouldCapture) {
            await emptyPage.screenshot({
              path: join(screenshots, `fix-1842-step4-empty-${theme}-${viewport.name}.png`),
            });
          }
        }
      } finally {
        await emptyPage.close();
      }

      const page = await openTheme(realApp, theme);
      try {
        await openSeededChat(page);
        await closeSidebars(page);
        for (const viewport of VIEWPORTS) {
          await assertTranscript(page, viewport);
          if (shouldCapture) {
            await page.screenshot({
              path: join(screenshots, `fix-1842-step4-transcript-${theme}-${viewport.name}.png`),
            });
            const codeView = page.locator("[data-code-view]").first();
            await codeView.scrollIntoViewIfNeeded();
            await page.screenshot({
              path: join(screenshots, `fix-1842-step4-figures-${theme}-${viewport.name}.png`),
            });
            const table = page.locator("[data-markdown-table]").first();
            await table.scrollIntoViewIfNeeded();
            await page.screenshot({
              path: join(screenshots, `fix-1842-step4-table-${theme}-${viewport.name}.png`),
            });
          }
        }
      } finally {
        await page.close();
      }
      const errorPage = await openTheme(realApp, theme);
      try {
        await openSeededChat(errorPage);
        await closeSidebars(errorPage);
        const errorComposer = errorPage.getByRole("textbox", { name: "Message input" });
        await sendPrompt(errorComposer, "fail_probe_child please");
        await expect(errorPage.locator('[data-ending="error"]').first()).toBeVisible({
          timeout: 120_000,
        });
        for (const viewport of VIEWPORTS) {
          await assertError(errorPage, viewport);
          if (shouldCapture) {
            await errorPage.screenshot({
              path: join(screenshots, `fix-1842-step4-error-${theme}-${viewport.name}.png`),
            });
          }
        }
      } finally {
        await errorPage.close();
      }

      const streamingPage = await openTheme(realApp, theme);
      try {
        const composer = await startChat(streamingPage);
        await sendPrompt(composer, "stream_held");
        await expect(streamingPage.getByText("Here is the long streamed block:")).toBeVisible({
          timeout: 60_000,
        });
        await closeSidebars(streamingPage);
        for (const viewport of VIEWPORTS) {
          await streamingPage.setViewportSize({ width: viewport.width, height: viewport.height });
          await waitForFiniteAnimations(streamingPage);
          if (shouldCapture) {
            await streamingPage.screenshot({
              path: join(screenshots, `fix-1842-step4-streaming-${theme}-${viewport.name}.png`),
            });
          }
        }
      } finally {
        await writeFile(join(realApp.agentDir, "release-held-reply"), "");
        await streamingPage.close();
      }

      const reducedPage = await openTheme(realApp, theme, true);
      try {
        const newChat = reducedPage
          .locator('[aria-label="Sessions"]')
          .getByRole("button", { name: "New chat" })
          .first();
        await expect(newChat).toBeVisible();
        await newChat.click();
        await expect(reducedPage.locator('[data-slot="u1-thread-loading"]')).toHaveCount(0);
        await expect(reducedPage.locator('[data-empty-chat="true"]')).toBeVisible({
          timeout: 60_000,
        });
        await expect(
          reducedPage.locator('[data-shell-main="true"][data-new-chat="true"]'),
        ).toBeAttached();
      } finally {
        await reducedPage.close();
      }
    }
  },
);
