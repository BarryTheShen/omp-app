/**
 * What the extension runs inside its tab, through `scripting.executeScript`: Firefox sends each function's source to the
 * page, so a function here uses nothing outside itself (no imports, no helpers of this module), and takes and returns only
 * plain data.
 *
 * Each takes omp app's own origins first (`appOrigins` in `tools.ts`: its address and, for an app on this computer, the
 * other loopback names of it) and refuses to run on a page of them (`OFF_LIMITS` in `tools.ts`, the same words): the check
 * runs in the page itself, so a tab that went to the app a moment before is refused too. So is any page with omp app's
 * root marker (`data-app-root` on the app's and the lite view's root, `data-omp-app` on its pairing, no-link, refused,
 * failed and connecting screens), whatever address it came by: the app may be reached at an address the panel was not
 * given. A chat acting on the app's pages could answer its own approvals, a pairing request or the settings.
 */

export interface PageLink {
  readonly text: string;
  readonly href: string;
}

export interface PageReading {
  readonly title: string;
  readonly url: string;
  readonly selection: string;
  readonly text: string;
  /** The page had more text than was read. */
  readonly truncated: boolean;
  readonly links: readonly PageLink[];
}

/** Either what was done, or why not, in a sentence. */
export type PageOutcome = { readonly done: string } | { readonly error: string };

/** The page's title, address, selection, text (the first `maxChars`) and its first `maxLinks` web links. */
export function readPage(
  blocked: readonly string[],
  maxChars: number,
  maxLinks: number,
): PageReading {
  if (
    blocked.includes(location.origin) ||
    document.querySelector("[data-app-root], [data-omp-app]") !== null
  )
    throw new Error("omp app's own pages are off limits to this panel.");
  // A title, an address or a link of any length would make one reading as long as the page wants.
  const LONGEST = 2_000;
  const collapse = (value: string): string =>
    value
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/\n[ \t]*\n(\s*\n)+/g, "\n\n")
      .trim();
  const full = collapse(document.body?.innerText ?? "");
  const links: PageLink[] = [];
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    if (links.length >= maxLinks) break;
    const href = (anchor as HTMLAnchorElement).href;
    if (!/^https?:/i.test(href)) continue;
    const text = collapse(
      (anchor as HTMLElement).innerText || anchor.getAttribute("aria-label") || "",
    ).slice(0, 120);
    links.push({ text, href: href.slice(0, LONGEST) });
  }
  return {
    title: document.title.slice(0, LONGEST),
    url: location.href.slice(0, LONGEST),
    selection: collapse(String(getSelection() ?? "")).slice(0, 8_000),
    text: full.slice(0, maxChars),
    truncated: full.length > maxChars,
    links,
  };
}

/** Clicks the element `selector` matches, or the first visible link or button whose words hold `text`. */
export function clickTarget(
  blocked: readonly string[],
  selector: string | null,
  text: string | null,
): PageOutcome {
  if (
    blocked.includes(location.origin) ||
    document.querySelector("[data-app-root], [data-omp-app]") !== null
  )
    throw new Error("omp app's own pages are off limits to this panel.");
  const visible = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden";
  };
  // A field's value is what the person typed, or a password the browser filled: only a button's value is its words.
  const buttonValue = (element: Element): string =>
    element instanceof HTMLInputElement && /^(button|submit|reset)$/i.test(element.type)
      ? element.value
      : "";
  const wordsOf = (element: Element): string =>
    (
      (element as HTMLElement).innerText ||
      element.getAttribute("aria-label") ||
      buttonValue(element) ||
      element.getAttribute("title") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
  const named = (element: Element): string => {
    const words = wordsOf(element).slice(0, 80);
    return `${element.tagName.toLowerCase()}${words === "" ? "" : ` “${words}”`}`;
  };
  let target: Element | null = null;
  if (selector !== null) {
    try {
      target = document.querySelector(selector);
    } catch {
      return { error: `"${selector}" is not a CSS selector.` };
    }
    if (target === null) return { error: `Nothing on the page matches "${selector}".` };
  } else if (text !== null) {
    const wanted = text.replace(/\s+/g, " ").trim().toLowerCase();
    const clickable = Array.from(
      document.querySelectorAll(
        "a, button, summary, label, input[type=button], input[type=submit], input[type=checkbox], input[type=radio], [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox]",
      ),
    );
    target =
      clickable.find((element) => visible(element) && wordsOf(element).toLowerCase() === wanted) ??
      clickable.find(
        (element) => visible(element) && wordsOf(element).toLowerCase().includes(wanted),
      ) ??
      null;
    if (target === null) return { error: `No visible link or button says "${text}".` };
  } else {
    return { error: "Say what to click: a CSS selector, or the words on it." };
  }
  (target as HTMLElement).scrollIntoView({ block: "center" });
  (target as HTMLElement).click();
  return { done: `Clicked ${named(target)}.` };
}

/** Types `text` into the field `selector` matches (or the one with the focus), as a person would; `submit` sends its form. */
export function typeInto(
  blocked: readonly string[],
  selector: string | null,
  text: string,
  submit: boolean,
): PageOutcome {
  if (
    blocked.includes(location.origin) ||
    document.querySelector("[data-app-root], [data-omp-app]") !== null
  )
    throw new Error("omp app's own pages are off limits to this panel.");
  let field: Element | null = null;
  if (selector !== null) {
    try {
      field = document.querySelector(selector);
    } catch {
      return { error: `"${selector}" is not a CSS selector.` };
    }
    if (field === null) return { error: `Nothing on the page matches "${selector}".` };
  } else {
    field = document.activeElement;
    if (field === null || field === document.body)
      return { error: "No field has the focus: say which field, with a CSS selector." };
  }
  const isText = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement;
  const rich = (field as HTMLElement).isContentEditable;
  if (!isText && !rich)
    return { error: `The ${field.tagName.toLowerCase()} is not a field to type into.` };
  (field as HTMLElement).focus();
  if (isText) {
    // The element's own setter, not the page's: a page that tracks its fields (React) then sees the change.
    const prototype =
      field instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    document.execCommand("selectAll");
    document.execCommand("insertText", false, text);
  }
  if (submit) {
    const form = (field as HTMLInputElement).form ?? field.closest("form");
    if (form !== null) form.requestSubmit();
    else {
      for (const type of ["keydown", "keypress", "keyup"])
        field.dispatchEvent(
          new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true }),
        );
    }
  }
  return {
    done: `Typed ${text.length} characters into the ${field.tagName.toLowerCase()}${submit ? ", and sent it" : ""}.`,
  };
}

/** Scrolls to the top or the bottom, by some pixels, or to the element `selector` matches. */
export function scrollPage(
  blocked: readonly string[],
  to: "top" | "bottom" | null,
  by: number | null,
  selector: string | null,
): PageOutcome {
  if (
    blocked.includes(location.origin) ||
    document.querySelector("[data-app-root], [data-omp-app]") !== null
  )
    throw new Error("omp app's own pages are off limits to this panel.");
  if (selector !== null) {
    let target: Element | null;
    try {
      target = document.querySelector(selector);
    } catch {
      return { error: `"${selector}" is not a CSS selector.` };
    }
    if (target === null) return { error: `Nothing on the page matches "${selector}".` };
    target.scrollIntoView({ block: "center" });
  } else if (to === "top") window.scrollTo(0, 0);
  else if (to === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
  else if (by !== null) window.scrollBy(0, by);
  else return { error: "Say where to: top, bottom, some pixels, or a CSS selector." };
  const height = document.documentElement.scrollHeight;
  return { done: `The page is at ${Math.round(window.scrollY)} of ${height} pixels.` };
}

/** Whether the page's text holds `text`, in any case. */
export function hasText(blocked: readonly string[], text: string): boolean {
  if (
    blocked.includes(location.origin) ||
    document.querySelector("[data-app-root], [data-omp-app]") !== null
  )
    throw new Error("omp app's own pages are off limits to this panel.");
  return (document.body?.innerText ?? "").toLowerCase().includes(text.toLowerCase());
}

/**
 * Refuses omp app's own pages, as every page function does, for a tool that needs no other page function to run (the
 * picture): it throws the same words on a page of the app and does nothing elsewhere.
 */
export function refuseApp(blocked: readonly string[]): void {
  if (
    blocked.includes(location.origin) ||
    document.querySelector("[data-app-root], [data-omp-app]") !== null
  )
    throw new Error("omp app's own pages are off limits to this panel.");
}

/**
 * Tells the panel what is selected, a moment after it changes, until the page is left: run once in the bound tab after
 * each load. Firefox gives the function its extension's `browser` in the page's content-script world. On omp app's own
 * pages it watches nothing, and it looks again at each change, since the app may draw itself after this was installed.
 * A page script can select text by itself, and the selection goes with the person's messages: a change counts only when
 * it follows the person's own pointer or key, which a script cannot fake but can react to.
 */
export function watchSelection(blocked: readonly string[]): void {
  const appPage = (): boolean =>
    blocked.includes(location.origin) ||
    document.querySelector("[data-app-root], [data-omp-app]") !== null;
  if (appPage()) return;
  const flag = "__ompAppWatchesSelection";
  const scope = window as unknown as Record<string, unknown>;
  if (scope[flag] === true) return;
  scope[flag] = true;
  let lastTrusted = 0;
  const trust = (event: Event): void => {
    if (event.isTrusted) lastTrusted = Date.now();
  };
  for (const type of ["pointerdown", "pointerup", "mouseup", "touchend", "keydown", "keyup"])
    document.addEventListener(type, trust, true);
  // A drag that selects goes on after the pointer went down: its moves with a button held count too.
  document.addEventListener(
    "pointermove",
    (event) => {
      if (event.isTrusted && event.buttons !== 0) lastTrusted = Date.now();
    },
    true,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  document.addEventListener("selectionchange", () => {
    if (Date.now() - lastTrusted > 1_000 || appPage()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (appPage()) return;
      const selection = String(getSelection() ?? "").slice(0, 8_000);
      browser.runtime.sendMessage({ type: "omp-app-selection", selection }).catch(() => undefined);
    }, 300);
  });
}
