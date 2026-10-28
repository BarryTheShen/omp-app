import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const RUNS = 8;

type ListRead = { sent: number; received?: number; scope: string };
type ContextClickTiming = {
  eventDuration: number | null;
  nextFrame: number | null;
  controlsReady: number | null;
};
type ProbeSnapshot = {
  readonly listCount: number;
  readonly pending: number;
  readonly pendingAll: number;
  readonly listEnd: number;
  readonly listEndAfterSeen: number;
  readonly listDurations: number[];
  readonly listDetails: string[];
  readonly contextClick: ContextClickTiming | null;
  readonly loadingAtContextClick: boolean | null;
};
type Probe = {
  begin: () => void;
  idleTickAfterOpen: () => boolean;
  markContextClick: () => void;
  contextClickFrameReady: () => boolean;
  finish: () => ProbeSnapshot;
};

declare global {
  interface Window {
    __settingsReadProbe: Probe;
  }
}

function seedEntries(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    type: "message",
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `Settings audit message ${index + 1}` }],
      ...(index % 2 === 1
        ? {
            api: "openai-completions",
            provider: "fake",
            model: "fake-model",
            stopReason: "stop",
          }
        : {}),
      timestamp: Date.UTC(2026, 9, 3) + index * 1000,
    },
  }));
}

function installListProbe(): void {
  const pending = new Map<string, ListRead>();
  const socketIds = new WeakMap<WebSocket, number>();
  let nextSocketId = 0;
  const requestKey = (socket: WebSocket, id: string | number): string => {
    let socketId = socketIds.get(socket);
    if (socketId === undefined) {
      socketId = nextSocketId++;
      socketIds.set(socket, socketId);
    }
    return `${socketId}:${id}`;
  };
  const calls: ListRead[] = [];
  let idleCallbacks = 0;
  let idleCallbacksBefore = 0;
  const nativeRequestIdleCallback = window.requestIdleCallback;
  if (typeof nativeRequestIdleCallback === "function") {
    window.requestIdleCallback = (callback, options) =>
      nativeRequestIdleCallback.call(
        window,
        (deadline) => {
          idleCallbacks += 1;
          callback(deadline);
        },
        options,
      );
  }
  let start = 0;
  let settingsSeenAt = 0;
  let contextClickStartedAt = 0;
  let contextClickReady: number | null = null;
  let loadingAtContextClick: boolean | null = null;
  let settingsSeenFrame: number | null = null;
  const settingsSeenObserver = new MutationObserver(() => {
    if (settingsSeenAt !== 0 || settingsSeenFrame !== null) return;
    if (document.querySelector('[role="dialog"][aria-label="Settings"]') === null) return;
    settingsSeenFrame = requestAnimationFrame(() => {
      settingsSeenFrame = null;
      if (document.querySelector('[role="dialog"][aria-label="Settings"]') !== null) {
        settingsSeenAt = performance.now();
      }
    });
  });
  const observeSettingsSeen = (): void => {
    const root = document.documentElement;
    if (root !== null) settingsSeenObserver.observe(root, { childList: true, subtree: true });
  };
  if (document.documentElement === null) {
    document.addEventListener("DOMContentLoaded", observeSettingsSeen, { once: true });
  } else {
    observeSettingsSeen();
  }
  const eventEntries: PerformanceEntry[] = [];
  const eventObserver = new PerformanceObserver((records) => {
    eventEntries.push(...records.getEntries());
  });
  eventObserver.observe({
    type: "event",
    durationThreshold: 16,
    buffered: false,
  } as PerformanceObserverInit);
  let contextClickArmed = false;
  let contextClickEventStart = 0;
  let contextClickFrame: number | null = null;
  document.addEventListener(
    "click",
    () => {
      if (!contextClickArmed) return;
      contextClickArmed = false;
      const clickedAt = performance.now();
      contextClickStartedAt = clickedAt;
      const dialog = document.querySelector('[role="dialog"][aria-label="Settings"]');
      loadingAtContextClick =
        dialog === null || (dialog.textContent ?? "").includes("Loading context settings…");
      requestAnimationFrame(() => {
        const readyAt = performance.now();
        contextClickFrame = readyAt - clickedAt;
        const search = dialog?.querySelector('[placeholder="Search context settings"]');
        const contextIsVisible = search !== null && search?.closest("[hidden]") === null;
        const contextIsLoaded = !(dialog?.textContent ?? "").includes("Loading context settings…");
        contextClickReady = contextIsVisible && contextIsLoaded ? readyAt - clickedAt : null;
      });
    },
    true,
  );
  const NativeWebSocket = window.WebSocket;
  const send = NativeWebSocket.prototype.send;
  NativeWebSocket.prototype.send = function (data: Parameters<WebSocket["send"]>[0]) {
    if (typeof data === "string" && data.includes('"method":"list"')) {
      const frame = JSON.parse(data) as {
        type?: string;
        method?: string;
        port?: string;
        id?: string | number;
        args?: { folder?: string | null; prefix?: string };
      };
      if (
        frame.type === "call" &&
        frame.port === "A1.configStore" &&
        frame.method === "list" &&
        frame.id !== undefined
      ) {
        const folderScope =
          frame.args?.folder === null
            ? "global"
            : frame.args?.folder === undefined
              ? "unset"
              : "project";
        const scope = `${folderScope}:${frame.args?.prefix ?? "<all>"}`;
        const call = { sent: performance.now(), scope };
        pending.set(requestKey(this as WebSocket, frame.id), call);
        calls.push(call);
      }
    }
    return send.call(this, data);
  };
  const onMessage = (event: MessageEvent): void => {
    if (typeof event.data !== "string" || pending.size === 0) return;
    const frame = JSON.parse(event.data) as { type?: string; id?: string | number };
    if (frame.type !== "result" || frame.id === undefined) return;
    const key = requestKey(event.currentTarget as WebSocket, frame.id);
    const call = pending.get(key);
    if (call === undefined) return;
    call.received = performance.now();
    pending.delete(key);
  };
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const socket = Reflect.construct(target, args) as WebSocket;
      socket.addEventListener("message", onMessage);
      return socket;
    },
  });
  window.__settingsReadProbe = {
    begin: () => {
      idleCallbacksBefore = idleCallbacks;
      if (settingsSeenFrame !== null) cancelAnimationFrame(settingsSeenFrame);
      settingsSeenFrame = null;
      settingsSeenAt = 0;
      start = performance.now();
    },
    idleTickAfterOpen: () => settingsSeenAt !== 0 && idleCallbacks > idleCallbacksBefore,
    markContextClick: () => {
      contextClickStartedAt = performance.now();
      contextClickReady = null;
      loadingAtContextClick = null;
      contextClickArmed = true;
      contextClickEventStart = eventEntries.length;
      contextClickFrame = null;
    },
    contextClickFrameReady: () => contextClickFrame !== null,
    finish: () => {
      const performanceEntries = eventObserver.takeRecords() as unknown as PerformanceEntry[];
      eventEntries.push(...performanceEntries);
      const lists = calls.filter((call) => call.sent >= start);
      const click = eventEntries
        .slice(contextClickEventStart)
        .filter((entry) => entry.name === "click" && entry.startTime >= contextClickStartedAt - 1)
        .sort((left, right) => left.startTime - right.startTime)
        .at(-1);
      return {
        listCount: lists.length,
        pending: lists.filter((call) => call.received === undefined).length,
        pendingAll: pending.size,
        listDurations: lists.map((call) =>
          call.received === undefined ? Number.POSITIVE_INFINITY : call.received - call.sent,
        ),
        listDetails: lists.map(
          (call) =>
            `${call.scope}:${call.received === undefined ? "pending" : (call.received - call.sent).toFixed(1)}`,
        ),
        listEnd:
          lists.length === 0 || lists.some((call) => call.received === undefined)
            ? Number.POSITIVE_INFINITY
            : Math.max(...lists.map((call) => (call.received ?? start) - start)),
        listEndAfterSeen:
          lists.length === 0 ||
          settingsSeenAt === 0 ||
          lists.some((call) => call.received === undefined)
            ? Number.POSITIVE_INFINITY
            : Math.max(
                0,
                ...lists.map((call) => (call.received ?? settingsSeenAt) - settingsSeenAt),
              ),
        contextClick:
          click === undefined && contextClickFrame === null && contextClickReady === null
            ? null
            : {
                eventDuration: click?.duration ?? null,
                nextFrame: contextClickFrame,
                controlsReady: contextClickReady,
              },
        loadingAtContextClick,
      };
    },
  };
}

async function readProbe(page: Page): Promise<ProbeSnapshot> {
  return page.evaluate(() => window.__settingsReadProbe.finish());
}

async function openSeededSession(page: Page): Promise<void> {
  const message = page.locator('[data-slot="u1-message-row"]');
  if ((await message.count()) === 0) {
    await page.getByText("Settings audit message 1", { exact: true }).click();
  }
  await expect(message.first()).toBeVisible({ timeout: 45_000 });
}

realTest.use({ seedEntries: { entries: seedEntries(500) } });

realTest("Settings preloads Context before its first click", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(600_000);
  const page = await realApp.open({
    beforeLoad: async (target) => {
      await target.addInitScript(installListProbe);
      await target.addInitScript(() => localStorage.setItem("omp-app.theme", "light"));
    },
  });
  await openSeededSession(page);
  const listCounts: number[] = [];
  const listEnds: number[] = [];
  const listEndsAfterSeen: number[] = [];
  const listDurations: number[] = [];
  const listDetails: string[] = [];
  const contextClickTimes: number[] = [];
  const contextControlsReadyTimes: number[] = [];
  const preloadedRuns: boolean[] = [];
  const loadingAtClickRuns: boolean[] = [];
  let eventTimingObserved = 0;

  for (let run = 0; run < RUNS; run += 1) {
    await expect.poll(async () => (await readProbe(page)).pendingAll, { timeout: 10_000 }).toBe(0);
    const settingsButton = await page
      .getByRole("button", { name: "Settings", exact: true })
      .elementHandle();
    if (settingsButton === null)
      throw new Error("Settings opener was not found before measurement.");
    const settingsBounds = await settingsButton.boundingBox();
    if (settingsBounds === null)
      throw new Error("Settings opener has no bounds before measurement.");
    await page.evaluate(() => {
      window.__settingsReadProbe.begin();
    });
    await page.mouse.click(
      settingsBounds.x + settingsBounds.width / 2,
      settingsBounds.y + settingsBounds.height / 2,
    );
    const dialog = page.locator('[role="dialog"][aria-label="Settings"]');
    await page.waitForFunction(
      () => document.querySelector('[role="dialog"][aria-label="Settings"]') !== null,
      null,
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => {
        const settings = document.querySelector('[role="dialog"][aria-label="Settings"]');
        if (settings === null || !window.__settingsReadProbe.idleTickAfterOpen()) return false;
        const contextTabs = settings.querySelectorAll(
          '[aria-label="Context sections"] [role="tab"]',
        );
        const text = settings.textContent ?? "";
        return (
          contextTabs.length === 4 &&
          !text.includes("Loading context settings…") &&
          !text.includes("Loading appearance settings…")
        );
      },
      null,
      { timeout: 20_000 },
    );
    preloadedRuns.push(true);
    const contextButton = await page
      .locator('[aria-label="Settings categories"] button')
      .filter({ hasText: /^Context$/ })
      .elementHandle();
    if (contextButton === null) throw new Error("Context tab was not found after Settings loaded.");
    const contextBounds = await contextButton.boundingBox();
    if (contextBounds === null) throw new Error("Context tab has no bounds after Settings loaded.");
    await page.evaluate(() => {
      window.__settingsReadProbe.markContextClick();
    });
    await page.mouse.click(
      contextBounds.x + contextBounds.width / 2,
      contextBounds.y + contextBounds.height / 2,
    );
    await page.waitForFunction(() => window.__settingsReadProbe.contextClickFrameReady(), null, {
      timeout: 10_000,
    });

    await expect
      .poll(async () => (await readProbe(page)).listCount, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect.poll(async () => (await readProbe(page)).pending, { timeout: 10_000 }).toBe(0);
    const reads = await readProbe(page);
    const contextTiming = reads.contextClick;
    if (contextTiming?.eventDuration !== null && contextTiming?.eventDuration !== undefined) {
      eventTimingObserved += 1;
    }
    contextClickTimes.push(
      contextTiming?.eventDuration ?? contextTiming?.nextFrame ?? Number.POSITIVE_INFINITY,
    );
    contextControlsReadyTimes.push(contextTiming?.controlsReady ?? Number.POSITIVE_INFINITY);
    loadingAtClickRuns.push(reads.loadingAtContextClick ?? true);
    listCounts.push(reads.listCount);
    listDurations.push(...reads.listDurations);
    listDetails.push(...reads.listDetails);
    // The overlay recorder owns the 150 ms gate; retain this aligned mark as diagnostic output.
    listEndsAfterSeen.push(reads.listEndAfterSeen);
    listEnds.push(reads.listEnd);
    await page.waitForFunction(
      () => {
        const settings = document.querySelector('[role="dialog"][aria-label="Settings"]');
        if (settings === null) return false;
        const search = settings.querySelector('[placeholder="Search context settings"]');
        return (
          search !== null &&
          search.closest("[hidden]") === null &&
          !settings.textContent?.includes("Loading context settings…")
        );
      },
      null,
      { timeout: 10_000 },
    );
    if (run === 0) {
      await mkdir(screenshots, { recursive: true });
      const background = await dialog.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      expect(background).not.toBe("rgba(0, 0, 0, 0)");
      await page.screenshot({ path: join(screenshots, "settings-read-context-light.png") });
      await page.locator("html").evaluate((element) => element.classList.add("dark"));
      await waitForFiniteAnimations(page);
      expect(
        await page.locator("html").evaluate((element) => element.classList.contains("dark")),
      ).toBe(true);
      const darkBackground = await dialog.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      expect(darkBackground).not.toBe("rgba(0, 0, 0, 0)");
      await page.screenshot({ path: join(screenshots, "settings-read-context-dark.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await waitForFiniteAnimations(page);
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      if (bounds === null) throw new Error("The Settings dialog has no visible bounds at 390 px.");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
      await page.screenshot({ path: join(screenshots, "settings-read-context-390.png") });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.locator("html").evaluate((element) => element.classList.remove("dark"));
      expect(
        await page.locator("html").evaluate((element) => element.classList.contains("dark")),
      ).toBe(false);
    }
    await dialog.getByRole("button", { name: "Close settings" }).click();
    await expect(dialog).toHaveCount(0);
    await waitForFiniteAnimations(page);
  }

  const contextTimes = [...contextClickTimes].sort((left, right) => left - right);
  const middle = Math.floor(contextTimes.length / 2);
  const p50 =
    contextTimes.length % 2 === 0
      ? ((contextTimes[middle - 1] ?? 0) + (contextTimes[middle] ?? 0)) / 2
      : (contextTimes[middle] ?? Number.POSITIVE_INFINITY);
  const worst = Math.max(...contextTimes);
  const contextControlsReadySorted = [...contextControlsReadyTimes].sort(
    (left, right) => left - right,
  );
  const contextControlsReadyMiddle = Math.floor(contextControlsReadySorted.length / 2);
  const contextControlsReadyP50 =
    contextControlsReadySorted.length % 2 === 0
      ? ((contextControlsReadySorted[contextControlsReadyMiddle - 1] ?? 0) +
          (contextControlsReadySorted[contextControlsReadyMiddle] ?? 0)) /
        2
      : (contextControlsReadySorted[contextControlsReadyMiddle] ?? Number.POSITIVE_INFINITY);
  const contextControlsReadyWorst = Math.max(...contextControlsReadyTimes);
  const listCountMax = Math.max(...listCounts);
  const listEndMax = Math.max(...listEnds);
  const listEndAfterSeenMax = Math.max(...listEndsAfterSeen);
  const listEndsAfterSeenSorted = [...listEndsAfterSeen].sort((left, right) => left - right);
  const listEndAfterSeenMiddle = Math.floor(listEndsAfterSeenSorted.length / 2);
  const listEndAfterSeenP50 =
    listEndsAfterSeenSorted.length % 2 === 0
      ? ((listEndsAfterSeenSorted[listEndAfterSeenMiddle - 1] ?? 0) +
          (listEndsAfterSeenSorted[listEndAfterSeenMiddle] ?? 0)) /
        2
      : (listEndsAfterSeenSorted[listEndAfterSeenMiddle] ?? Number.POSITIVE_INFINITY);
  const listDurationMax = Math.max(...listDurations);
  const contextPreloaded = preloadedRuns.every(Boolean);
  const loadingBeforeReady = loadingAtClickRuns.some(Boolean);
  console.log(
    [
      `SETTINGS_READ 500 messages: Context click B8 p50=${p50.toFixed(1)} ms, worst=${worst.toFixed(1)} ms`,
      `Event Timing entries=${eventTimingObserved}/${RUNS}; preload=${contextPreloaded}`,
      `Controls ready upper bound p50=${contextControlsReadyP50.toFixed(1)} ms, worst=${contextControlsReadyWorst.toFixed(1)} ms`,
      `loading-at-click=${loadingBeforeReady}; Settings list calls max=${listCountMax}`,
      `list end max=${listEndMax.toFixed(1)} ms; individual list call max=${listDurationMax.toFixed(1)} ms`,
      `list end after dialog seen p50=${listEndAfterSeenP50.toFixed(1)} ms; worst=${listEndAfterSeenMax.toFixed(1)} ms`,
    ].join("; "),
  );
  console.log(`SETTINGS_READ_CALLS ${listDetails.join(",")}`);
  expect(
    contextPreloaded,
    "Context section controls are mounted after the Settings open idle tick",
  ).toBe(true);
  expect(loadingBeforeReady, "Context does not show a loading state when first selected").toBe(
    false,
  );
  expect(listCountMax, "Settings open config list calls").toBeLessThanOrEqual(2);
  expect(p50, "Context controls visible p50 against B8").toBeLessThanOrEqual(100);
  expect(realApp.problems).toEqual([]);
});
