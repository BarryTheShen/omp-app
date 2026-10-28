import { expect, type Locator, type Page } from "@playwright/test";
import { ChatStream, settleChat } from "./n1-chat-stream";
import { realTest, sendPrompt, startChat, waitForFiniteAnimations } from "./real-omp";

const THEMES = ["light", "dark"] as const;
type Pair = {
  readonly name: string;
  readonly element: Locator;
  readonly minimum: number;
  readonly pseudo?: "::placeholder";
  readonly kind?: "text" | "border";
};

type MeasuredPair = { readonly name: string; readonly ratio: number; readonly minimum: number };

async function stableSelector(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const slot = element.getAttribute("data-slot");
    if (slot) {
      const selected = element.getAttribute("data-selected");
      return selected === null
        ? `[data-slot="${CSS.escape(slot)}"]`
        : `[data-slot="${CSS.escape(slot)}"][data-selected="${CSS.escape(selected)}"]`;
    }
    const notice = element.getAttribute("data-notice-key");
    if (notice) return `[data-notice-key="${CSS.escape(notice)}"]`;
    if (element.matches('[data-shell-region="composer"] textarea'))
      return '[data-shell-region="composer"] textarea';
    if (element.matches('[data-shell-region="status"]')) return '[data-shell-region="status"]';
    if (element.matches('[data-composer-toolbar="true"] button'))
      return '[data-composer-toolbar="true"] button:first-of-type';
    if (element.closest('[data-slot="p3-previous-message-selector"]'))
      return '[data-slot="p3-previous-message-selector"] button';
    if (element.matches('[aria-label="Panels"] [role="tab"]'))
      return '[aria-label="Panels"] [role="tab"]';
    if (element.matches("[data-composer-card]")) return "[data-composer-card]";
    const row = element.closest('[data-slot="r1-session-row"]');
    if (row) return '[data-slot="r1-session-row"][data-selected="true"] [class~="text-meta"]';
    const label = element.getAttribute("aria-label");
    if (label) return `[aria-label="${CSS.escape(label)}"]`;
    throw new Error(`Contrast surface has no stable selector: ${element.tagName}`);
  });
}

async function measurePairs(page: Page, pairs: readonly Pair[]): Promise<readonly MeasuredPair[]> {
  const descriptions = await Promise.all(
    pairs.map(async ({ name, minimum, pseudo, kind, element }) => ({
      name,
      minimum,
      pseudo,
      kind,
      selector: await stableSelector(element),
    })),
  );
  return page.evaluate(
    ({ descriptions }) => {
      type Rgba = [number, number, number, number];
      const parseColor = (value: string): Rgba | null => {
        const rgb = value.match(/rgba?\(([^)]+)\)/i);
        if (rgb) {
          const components = rgb[1] ?? "";
          const values = components
            .split(/[, /]+/)
            .filter(Boolean)
            .map(Number);
          const [red = 0, green = 0, blue = 0, alpha = 1] = values;
          if (values.length >= 3) return [red / 255, green / 255, blue / 255, alpha];
        }
        const oklch = value.match(
          /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/i,
        );
        if (!oklch) return value === "transparent" ? [0, 0, 0, 0] : null;
        const l = Number(oklch[1]);
        const c = Number(oklch[2]);
        const h = (Number(oklch[3]) * Math.PI) / 180;
        const alphaPart = oklch[4] ?? "";
        const alpha =
          alphaPart === "" ? 1 : Number.parseFloat(alphaPart) / (alphaPart.endsWith("%") ? 100 : 1);
        const a = c * Math.cos(h);
        const b = c * Math.sin(h);
        const lmsPrime = [
          l + 0.1279906356 * a + 0.0047314577 * b,
          l - 0.1361767045 * a - 0.004695138 * b,
          l - 0.134172799 * a - 0.106239523 * b,
        ];
        const lms = lmsPrime.map((value) => value ** 3);
        const at = (values: readonly number[], index: number): number => values[index] ?? 0;
        const xyz = [
          1.2270138511 * at(lms, 0) - 0.5577999807 * at(lms, 1) + 0.281256149 * at(lms, 2),
          -0.0405801784 * at(lms, 0) + 1.112256869 * at(lms, 1) - 0.0716766787 * at(lms, 2),
          -0.0763812845 * at(lms, 0) - 0.4214819784 * at(lms, 1) + 1.5861632204 * at(lms, 2),
        ];
        const linear = [
          3.2409699419 * at(xyz, 0) - 1.5373831776 * at(xyz, 1) - 0.4986107603 * at(xyz, 2),
          -0.9692436363 * at(xyz, 0) + 1.8759675015 * at(xyz, 1) + 0.0415550574 * at(xyz, 2),
          0.0556300797 * at(xyz, 0) - 0.2039769589 * at(xyz, 1) + 1.0569715142 * at(xyz, 2),
        ];
        const srgb = linear.map((value) =>
          value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055,
        );
        return [at(srgb, 0), at(srgb, 1), at(srgb, 2), alpha];
      };
      const over = (top: Rgba, bottom: Rgba): Rgba => {
        const alpha = top[3] + bottom[3] * (1 - top[3]);
        if (alpha === 0) return [0, 0, 0, 0];
        return [
          (top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / alpha,
          (top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / alpha,
          (top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / alpha,
          alpha,
        ];
      };
      const luminance = (rgb: Rgba): number => {
        const weights = [0.2126, 0.7152, 0.0722];
        return rgb.slice(0, 3).reduce((sum, value, index) => {
          const linear = value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          return sum + linear * (weights[index] ?? 0);
        }, 0);
      };
      const backgroundOf = (element: Element): Rgba => {
        const layers: Rgba[] = [];
        for (let node: Element | null = element; node !== null; node = node.parentElement) {
          const color = parseColor(getComputedStyle(node).backgroundColor);
          if (color && color[3] > 0) layers.push(color);
          if (color && color[3] >= 1) break;
        }
        let result: Rgba = [1, 1, 1, 1];
        for (const layer of layers.reverse()) result = over(layer, result);
        return result;
      };
      return descriptions.map(({ name, selector, minimum, pseudo, kind }) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Contrast surface is missing: ${name} (${selector})`);
        const style = getComputedStyle(element, pseudo);
        const foreground = parseColor(kind === "border" ? style.borderTopColor : style.color);
        if (!foreground) throw new Error(`Cannot parse ${kind ?? "text"} color for ${name}`);
        const background = backgroundOf(element);
        const ratio =
          (Math.max(luminance(foreground), luminance(background)) + 0.05) /
          (Math.min(luminance(foreground), luminance(background)) + 0.05);
        return { name, ratio, minimum };
      });
    },
    { descriptions },
  );
}

for (const theme of THEMES) {
  realTest(`measures rendered contrast pairs (${theme})`, async ({ realApp }) => {
    const chat = new ChatStream();
    const page = await realApp.open({
      beforeLoad: async (loadedPage) => {
        await loadedPage.addInitScript(
          (value) => window.localStorage.setItem("omp-app.theme", value),
          theme,
        );
        await loadedPage.emulateMedia({ colorScheme: theme });
        await chat.route(loadedPage);
      },
    });
    try {
      const composer = await startChat(page);
      await sendPrompt(composer, "Please write a short answer for the contrast audit.");
      await expect(page.locator('[data-slot="u1-message-row"][data-role="assistant"]')).toBeVisible(
        { timeout: 60_000 },
      );
      await settleChat(chat);
      await page.setViewportSize({ width: 1280, height: 800 });
      // The Panels start closed on a first run (#2570): open them, so their tab label is measured too.
      await page.getByRole("button", { name: "Show panels sidebar" }).click();
      await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
        "data-open",
        "true",
      );
      await waitForFiniteAnimations(page);
      const selectedRow = page
        .locator('[data-slot="r1-session-row"][data-selected="true"]')
        .first();
      const normalRow = selectedRow;
      const transcript = page
        .locator('[data-slot="u1-message-row"][data-role="assistant"]')
        .first();
      const muted = page
        .locator('[data-shell-region="status"] [class~="text-muted-foreground"]')
        .first();
      const placeholder = page.locator('[data-shell-region="composer"] textarea');
      const status = page.locator('[data-shell-region="status"]');
      const tab = page.locator('[aria-label="Panels"] [role="tab"]').first();
      const toolbar = page.locator('[data-composer-toolbar="true"] button').first();
      const button = page.getByRole("button", { name: "Edit an earlier message", exact: true });
      const selectedRowDetail = selectedRow.locator('[class~="text-meta"]').last();
      for (const surface of [
        normalRow,
        selectedRow,
        transcript,
        muted,
        placeholder,
        status,
        tab,
        toolbar,
        button,
        selectedRowDetail,
      ])
        await expect(surface).toBeVisible();
      const noticePairs: MeasuredPair[] = [];
      const baseline = await measurePairs(page, [
        { name: "sidebar row selected title", element: selectedRow, minimum: 4.5 },
        { name: "sidebar row selected time/status", element: selectedRowDetail, minimum: 4.5 },
      ]);
      await normalRow.hover();
      const pairs: MeasuredPair[] = [
        ...baseline,
        ...(await measurePairs(page, [
          { name: "sidebar row hovered title", element: normalRow, minimum: 4.5 },
          {
            name: "sidebar row hovered time/status",
            element: normalRow.locator('[class~="text-meta"]').last(),
            minimum: 4.5,
          },
        ])),
        ...noticePairs,
        ...(await measurePairs(page, [
          { name: "transcript text", element: transcript, minimum: 4.5 },
          { name: "muted text", element: muted, minimum: 4.5 },
          { name: "placeholder", element: placeholder, pseudo: "::placeholder", minimum: 4.5 },
          { name: "status words", element: status, minimum: 4.5 },
          { name: "Panels tab label", element: tab, minimum: 4.5 },
          { name: "composer toolbar text", element: toolbar, minimum: 4.5 },
          { name: "button text", element: button, minimum: 4.5 },
        ])),
      ];
      for (const pair of pairs)
        process.stdout.write(
          `Contrast (${theme}) | ${pair.name} | ${pair.ratio.toFixed(2)}:1 | minimum ${pair.minimum}:1 | ${pair.ratio >= pair.minimum ? "pass" : "FAIL"}\n`,
        );
      expect(pairs.filter((pair) => pair.ratio < pair.minimum)).toEqual([]);
    } finally {
      await page.close();
    }
  });
}
