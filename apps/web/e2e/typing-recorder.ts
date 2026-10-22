/**
 * The keystroke recorder of #2269 (`.data/perf/plan-typing.md`, section 4, T0). `recordTyping` runs in the page before any
 * script (`target.addInitScript(recordTyping, { census })`). For every key it records the keydown and input handlers
 * (window capture to window bubble, which spans React's root handler and its synchronous commit), the React commits, the
 * first and second animation frames after the key, and the event timings, long tasks and long animation frames of the page.
 * With `census` it also counts the renders of each commit by component name and the layout reads of each key; that needs
 * the non-minified census build, where component and function names survive. The node side (`typing-cost.spec.ts`) reads
 * the browser's counters around each key over CDP, waits for `__typingSettled` after it, and reads the log with
 * `readTypingLog`.
 */
import type { Page } from "@playwright/test";
import { LONG_CHAT } from "./motion-audit-recorder";

export interface TypingOptions {
  /** Count renders per component and layout reads per key (census build only). */
  readonly census: boolean;
}

/** One key, from its keydown to the second animation frame after it. Times are `performance.now()` in ms; -1 is unset. */
export interface TypingKey {
  /** Keydown, window capture. */
  readonly at: number;
  /** The second animation frame after the keydown. */
  end: number;
  /** Keydown handler: window capture to window bubble. */
  hkd: number;
  /** Input handler: window capture to window bubble. */
  hin: number;
  /** Keydown to the first animation frame. */
  fr1: number;
  /** React commits between the keydown and `end`. */
  commits: number;
  /** Keydown to the last commit of the key (0 when there was none). */
  lastCommit: number;
  /** Census: renders per component name, summed over the key's commits. */
  renders: Map<string, number>;
  /** Census: layout reads per call site, as `read <- caller`. */
  reads: Map<string, number>;
}

/** A span the page reported: an event timing (16 ms and over), a long task or a long animation frame. */
export interface TypingSpan {
  readonly name: string;
  readonly start: number;
  readonly duration: number;
  /** Long animation frames: the forced style and layout time of their scripts, summed (0 otherwise). */
  readonly forced: number;
}

export interface TypingLog {
  readonly keys: TypingKey[];
  readonly eventTimings: TypingSpan[];
  readonly longTasks: TypingSpan[];
  readonly frames: TypingSpan[];
  /** Every React commit of the page, keys or not. */
  commits: number;
}

/** The log as plain data (what `readTypingLog` returns): the census maps of each key are objects. */
export interface SerializedTypingKey extends Omit<TypingKey, "renders" | "reads"> {
  readonly renders: Record<string, number>;
  readonly reads: Record<string, number>;
}

export interface SerializedTypingLog extends Omit<TypingLog, "keys"> {
  readonly keys: SerializedTypingKey[];
}

interface TypingWindow {
  __typing?: TypingLog;
  /** Resolves after the second animation frame of the pending key, at once when no key is pending. */
  __typingSettled?: () => Promise<void>;
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown;
}

/** The fields of a fiber the census reads (React's internal shape, as the DevTools hook receives it). */
interface Named {
  readonly displayName?: string;
  readonly name?: string;
  readonly render?: Named;
  readonly type?: Named;
}

interface Fiber {
  readonly child: Fiber | null;
  readonly sibling: Fiber | null;
  readonly flags: number;
  readonly tag: number;
  readonly type: Named | string | null;
}

/** Runs in the page before any script. Self-contained on purpose: Playwright sends its source to the page. */
export function recordTyping(options: TypingOptions): void {
  const target = window as unknown as TypingWindow;
  if (target.__typing !== undefined) return;
  const log: TypingLog = { keys: [], eventTimings: [], longTasks: [], frames: [], commits: 0 };
  target.__typing = log;
  let current: TypingKey | null = null;
  let inputStart = 0;
  let waiters: Array<() => void> = [];

  // Census: a layout read counts against the pending key, under its call site: the first stack frame that is not one of
  // the recorder's own readers. The readers are named (censusNote, censusNoteElement, censusStyle, censusSize, censusRect),
  // so the frame is found by its name and not by a fixed depth.
  const censusNote = (label: string): void => {
    if (current === null) return;
    const frame = (new Error().stack ?? "")
      .split("\n")
      .slice(1)
      .find((line) => !/\bcensus(Note|NoteElement|Style|Size|Rect)\b/.test(line));
    const caller = /at (\S+)/.exec(frame ?? "")?.[1] ?? "?";
    const key = `${label} <- ${caller}`;
    current.reads.set(key, (current.reads.get(key) ?? 0) + 1);
  };
  // A read of an element is labelled by its tag; the hidden textarea of a size-measuring library is named apart.
  const censusNoteElement = (what: string, node: Element): void => {
    const hidden =
      node instanceof HTMLTextAreaElement && node.getAttribute("aria-hidden") === "true";
    censusNote(`${what}:${hidden ? "textarea[hidden]" : node.tagName.toLowerCase()}`);
  };
  if (options.census) {
    const computed = window.getComputedStyle.bind(window);
    const censusStyle = (element: Element, pseudo?: string | null): CSSStyleDeclaration => {
      censusNote("getComputedStyle");
      return computed(element, pseudo);
    };
    window.getComputedStyle = censusStyle;
    const sizes: Array<[object, string]> = [
      [Element.prototype, "scrollHeight"],
      [Element.prototype, "clientHeight"],
      [Element.prototype, "clientWidth"],
      [HTMLElement.prototype, "offsetHeight"],
      [HTMLElement.prototype, "offsetWidth"],
    ];
    for (const [owner, name] of sizes) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      const read = descriptor?.get;
      if (descriptor === undefined || read === undefined) continue;
      Object.defineProperty(owner, name, {
        ...descriptor,
        get: function censusSize(this: Element) {
          censusNoteElement(name, this);
          return read.call(this);
        },
      });
    }
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function censusRect(this: Element): DOMRect {
      censusNoteElement("getBoundingClientRect", this);
      return rect.call(this);
    };
  }

  // Census: the renders of one commit. A component renders when its fiber carries PerformedWork (flag 1), but a fiber that
  // was not re-created in this commit keeps the flag of its last render. React re-creates a fiber by reusing its alternate
  // object, so a fiber is fresh in this commit exactly when it was not current after the previous commit. Every commit walks
  // the whole tree, so that set is always the previous commit's, and only fresh fibers with the flag are counted.
  const COMPONENT_TAGS = [0, 1, 11, 14, 15];
  let lastCurrent = new Set<Fiber>();
  const nameOf = (type: Fiber["type"]): string => {
    if (type === null) return "anonymous";
    if (typeof type === "string") return type;
    const inner = type.render ?? type.type;
    return type.displayName || inner?.displayName || inner?.name || type.name || "anonymous";
  };
  const countCommit = (root: Fiber): Map<string, number> => {
    const renders = new Map<string, number>();
    const nowCurrent = new Set<Fiber>();
    const walk = (fiber: Fiber): void => {
      nowCurrent.add(fiber);
      if (
        !lastCurrent.has(fiber) &&
        (fiber.flags & 1) !== 0 &&
        COMPONENT_TAGS.includes(fiber.tag)
      ) {
        const name = nameOf(fiber.type);
        renders.set(name, (renders.get(name) ?? 0) + 1);
      }
      for (let child = fiber.child; child !== null; child = child.sibling) walk(child);
    };
    walk(root);
    lastCurrent = nowCurrent;
    return renders;
  };

  // React's DevTools hook: React calls it on every commit. It is installed before React loads.
  target.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
      log.commits += 1;
      const renders = options.census ? countCommit(root.current) : new Map<string, number>();
      if (current === null) return;
      current.commits += 1;
      current.lastCommit = performance.now() - current.at;
      for (const [name, count] of renders) {
        current.renders.set(name, (current.renders.get(name) ?? 0) + count);
      }
    },
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    onScheduleFiberRoot: () => undefined,
    checkDCE: () => undefined,
    setErrorHandler: () => undefined,
  };

  window.addEventListener(
    "keydown",
    () => {
      const at = performance.now();
      const key: TypingKey = {
        at,
        end: -1,
        hkd: -1,
        hin: -1,
        fr1: -1,
        commits: 0,
        lastCommit: 0,
        renders: new Map(),
        reads: new Map(),
      };
      log.keys.push(key);
      current = key;
      requestAnimationFrame(() => {
        key.fr1 = performance.now() - at;
        requestAnimationFrame(() => {
          key.end = performance.now();
          if (current === key) current = null;
          const done = waiters;
          waiters = [];
          for (const resolve of done) resolve();
        });
      });
    },
    true,
  );
  window.addEventListener(
    "keydown",
    () => {
      if (current !== null) current.hkd = performance.now() - current.at;
    },
    false,
  );
  window.addEventListener(
    "input",
    () => {
      inputStart = performance.now();
    },
    true,
  );
  window.addEventListener(
    "input",
    () => {
      if (current !== null) current.hin = performance.now() - inputStart;
    },
    false,
  );

  target.__typingSettled = () => {
    if (current === null) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push(resolve);
    return promise;
  };

  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      log.eventTimings.push({
        name: entry.name,
        start: entry.startTime,
        duration: entry.duration,
        forced: 0,
      });
    }
  }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      log.longTasks.push({
        name: "longtask",
        start: entry.startTime,
        duration: entry.duration,
        forced: 0,
      });
    }
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    // The entries' script timings are not in the DOM typings of every TypeScript version, so they are read here.
    const entries = list.getEntries() as unknown as Array<{
      startTime: number;
      duration: number;
      scripts: Array<{ forcedStyleAndLayoutDuration: number }>;
    }>;
    for (const entry of entries) {
      log.frames.push({
        name: "long-animation-frame",
        start: entry.startTime,
        duration: entry.duration,
        forced: entry.scripts.reduce((sum, script) => sum + script.forcedStyleAndLayoutDuration, 0),
      });
    }
  }).observe({ type: "long-animation-frame", buffered: true });
}

/** The page's log as plain data. Runs in the node side; the page reads its own maps into objects. */
export async function readTypingLog(page: Page): Promise<SerializedTypingLog> {
  return page.evaluate((): SerializedTypingLog => {
    const log = (window as unknown as TypingWindow).__typing;
    if (log === undefined) throw new Error("recordTyping did not run before the page loaded");
    return {
      ...log,
      keys: log.keys.map((key) => ({
        ...key,
        renders: Object.fromEntries(key.renders),
        reads: Object.fromEntries(key.reads),
      })),
    };
  });
}

/** Waits until the pending key's second animation frame, or at once when no key is pending. */
export function settleTyping(page: Page): Promise<void> {
  return page.evaluate(() => (window as unknown as TypingWindow).__typingSettled?.());
}

/**
 * A chat of `messages` entries shaped like `LONG_CHAT` (motion-audit-recorder.ts): question n and its answer, in turn,
 * with the same answer body and the same message fields, so the rows render as the audit's rows do.
 */
export function typingChat(messages: number): Array<Record<string, unknown>> {
  if (!Number.isInteger(messages) || messages < 2 || messages % 2 !== 0) {
    throw new Error(`TYPING_MESSAGES must be an even number of two or more, got ${messages}`);
  }
  interface ChatEntry {
    readonly type: string;
    readonly message: {
      readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
      readonly timestamp: number;
      readonly [field: string]: unknown;
    };
  }
  // The audit's fixture, typed loosely by its literal shape: its first two entries are the templates for the rest.
  const [question, reply] = LONG_CHAT as unknown as ChatEntry[];
  if (question === undefined || reply === undefined) throw new Error("LONG_CHAT has no entries");
  const replyText = reply.message.content[0]?.text ?? "";
  const body = replyText.slice(replyText.indexOf("\n\n") + 2);
  const start = question.message.timestamp;
  const pairMs = 2 * 60_000;
  return Array.from({ length: messages / 2 }, (_, index) => [
    {
      type: "message",
      message: {
        ...question.message,
        content: [
          { type: "text", text: `Question ${index + 1}: how do I keep the parser stable?` },
        ],
        timestamp: start + index * pairMs,
      },
    },
    {
      type: "message",
      message: {
        ...reply.message,
        content: [{ type: "text", text: `Answer ${index + 1}.\n\n${body}` }],
        timestamp: start + index * pairMs + 60_000,
      },
    },
  ]).flat();
}
