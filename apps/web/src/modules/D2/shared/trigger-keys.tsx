import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

interface TriggerKeyScopeValue {
  /** Counts the trigger lists in this scope that are loading their results. */
  readonly loading: (delta: 1 | -1) => void;
}

/** An Enter kept while a list loads: the scope it was pressed in, and the composer's textarea. */
interface KeptEnter {
  readonly scope: HTMLElement;
  readonly textarea: HTMLTextAreaElement;
}

const TriggerKeyScopeContext = createContext<TriggerKeyScopeValue | null>(null);

/** The Enter events `pressEnterAgain` dispatches: the scopes let them through to the composer. */
const replayed = new WeakSet<Event>();

/** The option the composer's textarea points at, when a list is open with one highlighted. */
function highlightedOption(textarea: HTMLTextAreaElement): HTMLElement | null {
  const activeId = textarea.getAttribute("aria-activedescendant");
  const item = activeId ? document.getElementById(activeId) : null;
  return item instanceof HTMLElement ? item : null;
}

/** Presses Enter in the composer again, as the person did: the composer sends the text. */
function pressEnterAgain(textarea: HTMLTextAreaElement): void {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  replayed.add(event);
  textarea.dispatchEvent(event);
}

/**
 * A list has answered. An Enter kept while it loaded is dropped when the list has options, because the
 * person chooses one with Enter; it is pressed again when the list has none, so the text is sent. A list
 * that closed meanwhile (the person kept typing or moved away) drops it.
 */
function settleKeptEnter({ scope, textarea }: KeptEnter): void {
  const listbox = scope.querySelector('[role="listbox"]');
  if (listbox === null || listbox.querySelector('[role="option"]') !== null) return;
  pressEnterAgain(textarea);
}

/**
 * The element that wraps the composer and the trigger lists rendered inside it. Every composer slot uses this
 * scope, so the key handling is written once. On Enter or Tab it chooses the option the composer's textarea
 * points at (`aria-activedescendant`), so the textarea must share a trigger root with the list. An Enter
 * pressed while a list in the scope is still loading is kept until the list answers (see `settleKeptEnter`);
 * Escape cancels it. Shift+Enter and Shift+Tab are left to the composer.
 */
export function TriggerKeyScope({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const pending = useRef(0);
  const kept = useRef<KeptEnter | null>(null);
  const value = useMemo<TriggerKeyScopeValue>(
    () => ({
      loading: (delta) => {
        pending.current += delta;
        const enter = kept.current;
        if (pending.current > 0 || enter === null) return;
        kept.current = null;
        // After the commit that renders the answer, so the list's options are in the page when they are read.
        queueMicrotask(() => settleKeptEnter(enter));
      },
    }),
    [],
  );
  const onKeyDownCapture = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (replayed.has(event.nativeEvent)) return;
    if (event.key === "Escape") kept.current = null;
    if (event.key !== "Enter" && event.key !== "Tab") return;
    if (event.shiftKey) return;
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    const option = highlightedOption(event.target);
    if (option) {
      event.preventDefault();
      event.stopPropagation();
      option.click();
      return;
    }
    const listOpen = event.currentTarget.querySelector('[role="listbox"]') !== null;
    if (event.key === "Enter" && pending.current > 0 && listOpen) {
      event.preventDefault();
      event.stopPropagation();
      kept.current = { scope: event.currentTarget, textarea: event.target };
    }
  }, []);
  return (
    <TriggerKeyScopeContext.Provider value={value}>
      <div className={className} onKeyDownCapture={onKeyDownCapture}>
        {children}
      </div>
    </TriggerKeyScopeContext.Provider>
  );
}

/**
 * A trigger list reports while it loads, so an Enter pressed during the search is kept until the list answers
 * (see `TriggerKeyScope`) and cannot send the text before the list has its options.
 */
export function useTriggerListLoading(loading: boolean): void {
  const scope = useContext(TriggerKeyScopeContext);
  useLayoutEffect(() => {
    if (!loading || scope === null) return undefined;
    scope.loading(1);
    return () => scope.loading(-1);
  }, [loading, scope]);
}
