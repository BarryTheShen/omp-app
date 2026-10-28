import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

/**
 * How a list settles an Enter kept while it loaded, once it answers with options. `choose` runs the option the
 * list highlights (its first); `drop` lets the key go, because the person never saw the list (issue 818).
 */
export type KeptEnterAnswer = "choose" | "drop";

interface TriggerKeyScopeValue {
  /**
   * Counts the trigger lists in this scope that are loading their results. A list that answers passes how it
   * settles a kept Enter; a list that passes none drops it.
   */
  readonly loading: (delta: 1 | -1, answer?: () => KeptEnterAnswer) => void;
  /**
   * Presses Enter in the composer again once a choose has committed, so the chosen command is sent. Returns true, and
   * sends nothing, when a Tab made the choose: Tab only completes the command.
   */
  readonly sendAfterChoose: () => boolean;
  /** The composer's textarea, read when it is needed: the caret and the text are current only there. */
  readonly composerTextarea: () => HTMLTextAreaElement | null;
  /**
   * The text before the caret when the choose in progress is one an Enter made (a held Enter's too), else null. It is
   * set only while the scope clicks the option that Enter chose, so a pointer choose and a Tab never read it.
   */
  readonly enterChoice: () => string | null;
}

/** An Enter kept while a list loads: the scope it was pressed in, and the composer's textarea. */
interface KeptEnter {
  readonly scope: HTMLElement;
  readonly textarea: HTMLTextAreaElement;
}

const TriggerKeyScopeContext = createContext<TriggerKeyScopeValue | null>(null);

/** The Enter events `pressEnterAgain` dispatches: the scopes let them through to the composer. */
const replayed = new WeakSet<Event>();

/** Keys that change no text: a press of one of them, or of Enter itself, leaves a held Enter armed. */
const TEXT_UNCHANGING_KEYS: Readonly<Record<string, true>> = {
  Enter: true,
  Shift: true,
  Control: true,
  Alt: true,
  Meta: true,
};

/** The keys a list answers to and an input method uses while it composes a word instead (issue 1334). */
const IME_KEYS: Readonly<Record<string, true>> = {
  Enter: true,
  Tab: true,
  ArrowUp: true,
  ArrowDown: true,
};

/**
 * The first element of `scope`'s own that matches `selector`. The composer's slots nest, so a scope also holds the lists
 * of the slots inside it: a nested slot's list and its rows are that slot's to choose, hold an Enter for and settle it
 * by (issue 2757).
 */
function ownElement(scope: HTMLElement, selector: string): HTMLElement | null {
  for (const element of scope.querySelectorAll<HTMLElement>(selector)) {
    if (element.closest("[data-trigger-scope]") === scope) return element;
  }
  return null;
}

/**
 * The option an Enter or Tab chooses: the one the composer's textarea points at, when a list is open with one
 * highlighted. The popover publishes that pointer in an effect, after it has rendered the rows, so until then the
 * textarea names no row, or the row a re-render has replaced. An Enter on an answered list therefore reads the rows:
 * the one marked `aria-selected` renders with them, and a list that marks none starts on its first row.
 */
function highlightedOption(
  textarea: HTMLTextAreaElement,
  scope: HTMLElement,
  answered: boolean,
): HTMLElement | null {
  const activeId = textarea.getAttribute("aria-activedescendant");
  const pointed = activeId ? document.getElementById(activeId) : null;
  if (pointed !== null && pointed.closest("[data-trigger-scope]") !== scope) return null;
  if (!answered) return pointed;
  return (
    ownElement(scope, '[role="option"][aria-selected="true"]') ??
    pointed ??
    ownElement(scope, '[role="option"]')
  );
}

/** Presses Enter in the composer again, as the person did: the composer sends the text. */
function pressEnterAgain(textarea: HTMLTextAreaElement): void {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  replayed.add(event);
  textarea.dispatchEvent(event);
}

/**
 * Clicks an option a key chose. An Enter's choose holds the text before the caret in `mark` while the click runs: the
 * click inserts synchronously (assistant-ui's item click selects the item at once), and the mark is cleared after it.
 */
function clickChosen(
  mark: { current: string | null },
  option: HTMLElement,
  typedOnEnter: string | null,
): void {
  mark.current = typedOnEnter;
  try {
    option.click();
  } finally {
    mark.current = null;
  }
}

/**
 * A list has answered. An Enter kept while it loaded is dropped when the list has options, unless the list
 * chooses for it: then the option it highlights (its first) is chosen (issue 1006). It is pressed again when the list
 * has none, so the text is sent. A list that closed meanwhile (the person kept typing or moved away) drops it.
 * Returns false, and changes nothing, when no list is in the page: the answer's list renders in a later commit.
 */
function settleKeptEnter(
  { scope, textarea }: KeptEnter,
  answer: (() => KeptEnterAnswer) | undefined,
  choose: (option: HTMLElement) => void,
): boolean {
  const listbox = ownElement(scope, '[role="listbox"]');
  if (listbox === null) return false;
  const first = listbox.querySelector<HTMLElement>('[role="option"]');
  if (first === null) {
    pressEnterAgain(textarea);
    return true;
  }
  if (answer?.() === "choose") choose(first);
  return true;
}

/** How long a held Enter waits for its list to answer with options. A list that never does has closed: the Enter drops. */
const LIST_SHOW_MS = 1000;

/**
 * Calls `onShown` once `scope` holds a list with options, or `onGaveUp` when none has after LIST_SHOW_MS. An empty list
 * does not count: a search that has not answered yet draws an empty list first. Returns how to stop waiting early.
 */
function waitForOptions(scope: HTMLElement, onShown: () => void, onGaveUp: () => void): () => void {
  const observer = new MutationObserver(() => {
    if (ownElement(scope, '[role="option"]') === null) return;
    stop();
    onShown();
  });
  const timer = window.setTimeout(() => {
    stop();
    onGaveUp();
  }, LIST_SHOW_MS);
  function stop(): void {
    observer.disconnect();
    window.clearTimeout(timer);
  }
  observer.observe(scope, { childList: true, subtree: true });
  return stop;
}

/**
 * The element that wraps the composer and the trigger lists rendered inside it. Every composer slot uses this
 * scope, so the key handling is written once. On Enter or Tab it chooses the option the composer's textarea
 * points at (`aria-activedescendant`), so the textarea must share a trigger root with the list. An Enter pressed
 * while the scope's own list is open and still loading is kept until that list answers (see `settleKeptEnter`), and
 * Escape cancels it; the list of a slot nested inside the scope is that slot's (issue 2757). Shift+Enter and Shift+Tab
 * are left to the composer. A highlighted row that `isCurrentRow` rejects is not chosen either.
 */
export function TriggerKeyScope({
  className,
  children,
  isCurrentRow,
  submitWhenLoading,
}: {
  readonly className?: string;
  readonly children: ReactNode;
  /**
   * Whether a highlighted row answers the text at the caret now. A row still on screen from earlier text is not chosen,
   * since choosing it would replace what was typed after it.
   */
  readonly isCurrentRow?: (textarea: HTMLTextAreaElement, row: HTMLElement) => boolean;
  /** Whether an Enter should pass through while a loading list is open. */
  readonly submitWhenLoading?: (textarea: HTMLTextAreaElement) => boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const pending = useRef(0);
  const kept = useRef<KeptEnter | null>(null);
  // Stops the wait of a held Enter whose list is not in the page yet (see settleHeld).
  const stopWaiting = useRef<(() => void) | null>(null);
  // A held Enter's wait ends with the scope: no observer or timer outlives it.
  useEffect(
    () => () => {
      stopWaiting.current?.();
      stopWaiting.current = null;
    },
    [],
  );
  // Set by a Tab choose until sendAfterChoose consumes it, or until the next key or pointer press in the scope.
  const tabChose = useRef(false);
  // The text an Enter chose a row with, while that choose runs (see clickChosen). Clicks and Tab never set it.
  const enterChoice = useRef<string | null>(null);
  // The newest row check, read by the key handler, which is created once for the scope.
  const rowIsCurrent = useRef(isCurrentRow);
  useLayoutEffect(() => {
    rowIsCurrent.current = isCurrentRow;
  });
  const submitWhenLoadingRef = useRef(submitWhenLoading);
  useLayoutEffect(() => {
    submitWhenLoadingRef.current = submitWhenLoading;
  });
  const value = useMemo<TriggerKeyScopeValue>(() => {
    // Settles a held Enter once its list has answered. The list hides in the commit where its loading ends and renders
    // the answer in the next one, so a list that is not in the page yet makes the Enter wait for its options (issue
    // 2245). An empty list that shows meanwhile is not an answer, so it does not settle the Enter.
    const settleHeld = (enter: KeptEnter, answer: (() => KeptEnterAnswer) | undefined): void => {
      if (pending.current > 0 || kept.current !== enter) return;
      if (
        settleKeptEnter(enter, answer, (option) =>
          clickChosen(
            enterChoice,
            option,
            enter.textarea.value.slice(0, enter.textarea.selectionEnd),
          ),
        )
      ) {
        kept.current = null;
        return;
      }
      stopWaiting.current?.();
      stopWaiting.current = waitForOptions(
        enter.scope,
        () => {
          stopWaiting.current = null;
          settleHeld(enter, answer);
        },
        () => {
          stopWaiting.current = null;
          if (kept.current === enter) kept.current = null;
        },
      );
    };
    return {
      loading: (delta, answer) => {
        pending.current += delta;
        const enter = kept.current;
        if (pending.current > 0 || enter === null) return;
        // After the commit that renders the answer, so the list's options are in the page when they are read.
        queueMicrotask(() => settleHeld(enter, answer));
      },
      sendAfterChoose: () => {
        // A choose that Tab made stops at the completed name: nothing is sent here, and Enter sends it later.
        if (tabChose.current) {
          tabChose.current = false;
          return true;
        }
        // After the choose has committed (the list has gone quiet), Enter is pressed again: the composer sends.
        queueMicrotask(() => {
          const textarea = element.current?.querySelector("textarea");
          if (textarea) pressEnterAgain(textarea);
        });
        return false;
      },
      composerTextarea: () => element.current?.querySelector("textarea") ?? null,
      enterChoice: () => enterChoice.current,
    };
  }, []);
  const onKeyDownCapture = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (replayed.has(event.nativeEvent)) return;
    // Any key ends a Tab choose's mark: the mark covers that one choose, not later keys or presses.
    tabChose.current = false;
    // Any key that can change the text drops a held Enter, so only the text the person confirmed with Enter is ever sent (issue 866).
    if (!Object.hasOwn(TEXT_UNCHANGING_KEYS, event.key)) kept.current = null;
    // A key that ends a held Enter's wait ends it: a text key or Escape has already dropped the Enter, and an Enter is a
    // new Enter (the composer sends the text, as it does when no list is open).
    if (stopWaiting.current !== null && (kept.current === null || event.key === "Enter")) {
      stopWaiting.current();
      stopWaiting.current = null;
      kept.current = null;
    }
    // While an input method composes a word, its keys belong to the IME (issue 1334): no list moves or chooses for one,
    // and the composer does not send one. Safari sends the Enter that commits a word after compositionend, with keyCode 229.
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      if (Object.hasOwn(IME_KEYS, event.key)) event.stopPropagation();
      return;
    }
    if (event.key !== "Enter" && event.key !== "Tab") return;
    if (event.shiftKey) return;
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    const listOpen = ownElement(event.currentTarget, '[role="listbox"]') !== null;
    if (
      event.key === "Enter" &&
      pending.current > 0 &&
      listOpen &&
      submitWhenLoadingRef.current?.(event.target) === true
    )
      return;
    const option = highlightedOption(
      event.target,
      event.currentTarget,
      event.key === "Enter" && pending.current === 0,
    );
    const isCurrent = rowIsCurrent.current;
    if (option && isCurrent && !isCurrent(event.target, option)) {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        kept.current = { scope: event.currentTarget, textarea: event.target };
      }
      return;
    }
    if (option) {
      event.preventDefault();
      event.stopPropagation();
      // Tab only completes: the choose it makes is marked, so sendAfterChoose does not send the command.
      if (event.key === "Tab") tabChose.current = true;
      clickChosen(
        enterChoice,
        option,
        event.key === "Enter" ? event.target.value.slice(0, event.target.selectionEnd) : null,
      );
      return;
    }
    if (event.key === "Enter" && pending.current > 0 && listOpen) {
      event.preventDefault();
      event.stopPropagation();
      kept.current = { scope: event.currentTarget, textarea: event.target };
    }
  }, []);
  return (
    <TriggerKeyScopeContext.Provider value={value}>
      <div
        ref={element}
        className={className}
        data-trigger-scope=""
        onKeyDownCapture={onKeyDownCapture}
        onPointerDownCapture={() => {
          tabChose.current = false;
        }}
      >
        {children}
      </div>
    </TriggerKeyScopeContext.Provider>
  );
}

/**
 * A trigger list reports while it loads, so an Enter pressed during the search is kept until the list answers
 * (see `TriggerKeyScope`) and cannot send the text before the list has its options. `answer` says how a kept Enter
 * is settled when the list answers with options; without one, the key is dropped.
 */
export function useTriggerListLoading(loading: boolean, answer?: () => KeptEnterAnswer): void {
  const scope = useContext(TriggerKeyScopeContext);
  useLayoutEffect(() => {
    if (!loading || scope === null) return undefined;
    scope.loading(1);
    return () => scope.loading(-1, answer);
  }, [loading, scope, answer]);
}

/**
 * A function that presses Enter again in the composer once a chosen command has committed, so the command runs. It
 * returns true, and sends nothing, when Tab made the choose.
 */
export function useSendAfterChoose(): () => boolean {
  const scope = useContext(TriggerKeyScopeContext);
  return useCallback(() => scope?.sendAfterChoose() ?? false, [scope]);
}

/**
 * The text an Enter chose a row with, while that choose runs; null for any other choose (a click, or Tab). A row that
 * sends on Enter reads it, so the key the person pressed decides whether the command is sent.
 */
export function useEnterChoice(): () => string | null {
  const scope = useContext(TriggerKeyScopeContext);
  return useCallback(() => scope?.enterChoice() ?? null, [scope]);
}

/** The composer's textarea inside this scope, for a list action that reads or moves the caret. */
export function useComposerTextarea(): () => HTMLTextAreaElement | null {
  const scope = useContext(TriggerKeyScopeContext);
  return useCallback(() => scope?.composerTextarea() ?? null, [scope]);
}
