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
  /** Presses Enter in the composer again once a choose has committed, so the chosen command is sent. */
  readonly sendAfterChoose: () => void;
  /** The composer's textarea, read when it is needed: the caret and the text are current only there. */
  readonly composerTextarea: () => HTMLTextAreaElement | null;
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
 * A list has answered. An Enter kept while it loaded is dropped when the list has options, unless the list
 * chooses for it: then the option it highlights (its first) is chosen (issue 1006). It is pressed again when the list
 * has none, so the text is sent. A list that closed meanwhile (the person kept typing or moved away) drops it.
 */
function settleKeptEnter(
  { scope, textarea }: KeptEnter,
  answer: (() => KeptEnterAnswer) | undefined,
): void {
  const listbox = scope.querySelector('[role="listbox"]');
  if (listbox === null) return;
  const first = listbox.querySelector<HTMLElement>('[role="option"]');
  if (first === null) {
    pressEnterAgain(textarea);
    return;
  }
  if (answer?.() === "choose") first.click();
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
  const element = useRef<HTMLDivElement>(null);
  const pending = useRef(0);
  const kept = useRef<KeptEnter | null>(null);
  const value = useMemo<TriggerKeyScopeValue>(
    () => ({
      loading: (delta, answer) => {
        pending.current += delta;
        const enter = kept.current;
        if (pending.current > 0 || enter === null) return;
        kept.current = null;
        // After the commit that renders the answer, so the list's options are in the page when they are read.
        queueMicrotask(() => settleKeptEnter(enter, answer));
      },
      sendAfterChoose: () => {
        // After the choose has committed (the list has gone quiet), Enter is pressed again: the composer sends.
        queueMicrotask(() => {
          const textarea = element.current?.querySelector("textarea");
          if (textarea) pressEnterAgain(textarea);
        });
      },
      composerTextarea: () => element.current?.querySelector("textarea") ?? null,
    }),
    [],
  );
  const onKeyDownCapture = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (replayed.has(event.nativeEvent)) return;
    // Any key that can change the text drops a held Enter, so only the text the person confirmed with Enter is ever sent (issue 866).
    if (!Object.hasOwn(TEXT_UNCHANGING_KEYS, event.key)) kept.current = null;
    // While an input method composes a word, its keys belong to the IME (issue 1334): no list moves or chooses for one,
    // and the composer does not send one. Safari sends the Enter that commits a word after compositionend, with keyCode 229.
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      if (Object.hasOwn(IME_KEYS, event.key)) event.stopPropagation();
      return;
    }
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
      <div ref={element} className={className} onKeyDownCapture={onKeyDownCapture}>
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

/** A function that presses Enter again in the composer once a chosen command has committed, so the command runs. */
export function useSendAfterChoose(): () => void {
  const scope = useContext(TriggerKeyScopeContext);
  return useCallback(() => scope?.sendAfterChoose(), [scope]);
}

/** The composer's textarea inside this scope, for a list action that reads or moves the caret. */
export function useComposerTextarea(): () => HTMLTextAreaElement | null {
  const scope = useContext(TriggerKeyScopeContext);
  return useCallback(() => scope?.composerTextarea() ?? null, [scope]);
}
