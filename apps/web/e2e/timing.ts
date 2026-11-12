import type { Page } from "@playwright/test";

/**
 * How long after the page's next click an element matching `selector` is in it: measured in the page, from the click's
 * own time to the change that put the element there. Start it before the click, await it after.
 */
export function drawnAfterClick(page: Page, selector: string): Promise<number> {
  return page.evaluate(
    (wanted) =>
      new Promise<number>((resolve) => {
        let clicked: number | undefined;
        addEventListener(
          "click",
          (event) => {
            clicked = event.timeStamp;
          },
          { capture: true, once: true },
        );
        const observer = new MutationObserver(() => {
          if (clicked === undefined || document.querySelector(wanted) === null) return;
          observer.disconnect();
          resolve(performance.now() - clicked);
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }),
    selector,
  );
}
