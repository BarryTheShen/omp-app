import { useAui } from "@assistant-ui/react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef } from "react";

/**
 * Mirrors omp v18.6.1's custom-editor Up/Down history boundary behavior from
 * `research/modules/U2.md:76-80` and the cited `src/modes/components/custom-editor.ts` source.
 */
export interface PromptHistorySource {
  getUserPrompts(): readonly string[];
  subscribe(listener: () => void): () => void;
}

export interface PromptHistorySnapshot {
  readonly prompts: readonly string[];
  readonly index: number;
  readonly draft: string | null;
}

/** What the controller reads from a key event: a React keyboard event fits, and so does a plain object. */
export interface PromptHistoryKeyEvent {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  /** True when an earlier handler took the key, as an open trigger list does for its arrows. */
  readonly defaultPrevented?: boolean;
  readonly nativeEvent?: { readonly isComposing?: boolean };
  preventDefault(): void;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((prompt, index) => prompt === b[index]);
}

/** Up leaves a multi-line prompt's text to the caret unless the caret is on the first line. */
function lineBreakAbove(text: string, caret: number): boolean {
  return text.slice(0, caret).includes("\n");
}

/** Down leaves a multi-line prompt's text to the caret unless the caret is on the last line. */
function lineBreakBelow(text: string, caret: number): boolean {
  return text.slice(caret).includes("\n");
}

/** R0.2-backed, in-memory navigation state; it never creates a second durable history store. */
export class PromptHistoryController {
  private prompts: readonly string[] = [];
  /** How far back browsing has gone: 0 is the newest prompt; -1 means the composer holds the user's own text. */
  private index = -1;
  /** The composer text from before browsing began; Down past the newest prompt restores it. */
  private draft: string | null = null;
  /** The prompt the composer was last given; text that differs from it was edited by the user. */
  private recalled: string | null = null;

  public constructor(source: PromptHistorySource) {
    this.prompts = source.getUserPrompts();
  }

  /** A different list (a prompt was sent, or the chat changed) ends browsing; the same list changes nothing. */
  public update(prompts: readonly string[]): void {
    if (sameList(prompts, this.prompts)) return;
    this.prompts = prompts;
    this.endBrowsing();
  }

  public snapshot(): PromptHistorySnapshot {
    return { prompts: this.prompts, index: this.index, draft: this.draft };
  }

  /** True while `text` is a prompt Up or Down put in the composer and the user has not edited it. */
  public isRecalled(text: string): boolean {
    return this.index >= 0 && text === this.recalled;
  }

  public search(query: string, limit = 50): readonly string[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (normalized.length === 0) return this.prompts.slice(-limit).reverse();
    const matches: string[] = [];
    for (let index = this.prompts.length - 1; index >= 0 && matches.length < limit; index -= 1) {
      const prompt = this.prompts[index];
      if (prompt?.toLocaleLowerCase().includes(normalized)) matches.push(prompt);
    }
    return matches;
  }

  public handleKeyDown(
    event: PromptHistoryKeyEvent,
    text: string,
    selectionStart: number,
    selectionEnd: number,
    setText: (text: string) => void,
    setSelection: (start: number, end: number) => void,
  ): boolean {
    // An arrow an open trigger list took, IME composition, modifiers and a selection are not history's.
    if (event.defaultPrevented === true) return false;
    if (
      event.nativeEvent?.isComposing === true ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      selectionStart !== selectionEnd
    )
      return false;
    // Text the user typed over a recalled prompt is theirs now, so browsing ends.
    if (this.index >= 0 && text !== this.recalled) this.endBrowsing();
    const browsing = this.index >= 0;
    if (event.key === "ArrowUp") {
      if (this.prompts.length === 0) return false;
      // Starting from the user's own text, only at its very start; while browsing, only on the first line.
      if (browsing ? lineBreakAbove(text, selectionStart) : selectionStart !== 0) return false;
      event.preventDefault();
      if (!browsing) this.draft = text;
      const index = Math.min(this.index + 1, this.prompts.length - 1);
      // The oldest prompt is already showing: keep the caret where it is.
      if (index === this.index) return true;
      this.recall(index, setText, setSelection);
      return true;
    }
    if (event.key === "ArrowDown") {
      if (!browsing || lineBreakBelow(text, selectionEnd)) return false;
      event.preventDefault();
      if (this.index === 0) {
        const draft = this.draft ?? "";
        this.endBrowsing();
        setText(draft);
        setSelection(draft.length, draft.length);
        return true;
      }
      this.recall(this.index - 1, setText, setSelection);
      return true;
    }
    return false;
  }

  private recall(
    index: number,
    setText: (text: string) => void,
    setSelection: (start: number, end: number) => void,
  ): void {
    const prompt = this.prompts[this.prompts.length - 1 - index] ?? "";
    this.index = index;
    this.recalled = prompt;
    setText(prompt);
    setSelection(0, 0);
  }

  private endBrowsing(): void {
    this.index = -1;
    this.draft = null;
    this.recalled = null;
  }
}

const NO_RECALLED_PROMPT = (): boolean => false;
const RecalledPromptContext = createContext<(text: string) => boolean>(NO_RECALLED_PROMPT);

/**
 * Whether `text` is a prompt U2.5 put in the composer, so a draft save can skip it: the saved draft
 * stays the user's own text. Outside a slot nothing is recalled.
 */
export function useIsRecalledPrompt(): (text: string) => boolean {
  return useContext(RecalledPromptContext);
}

/**
 * Attaches Up/Down prompt history to the composer inside it, without taking focus. It handles only
 * the keys that reach it after the composer's own handlers, so an open trigger list keeps its arrows,
 * and it ignores the edit composer nested in the composer's footer.
 */
export function PromptHistorySlot({
  source,
  children,
}: {
  readonly source: PromptHistorySource;
  readonly children: ReactNode;
}) {
  const composer = useAui().composer;
  const controllerRef = useRef<PromptHistoryController | null>(null);
  if (controllerRef.current === null) controllerRef.current = new PromptHistoryController(source);
  useEffect(() => {
    const update = (): void => controllerRef.current?.update(source.getUserPrompts());
    return source.subscribe(update);
  }, [source]);
  const isRecalled = useCallback(
    (text: string): boolean => controllerRef.current?.isRecalled(text) ?? false,
    [],
  );
  return (
    <RecalledPromptContext.Provider value={isRecalled}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a pass-through wrapper with no semantics of its own; the composer inside is the control, and it takes the arrow keys first. */}
      <div
        data-slot="u2-history-slot"
        onKeyDown={(event) => {
          const controller = controllerRef.current;
          const target = event.target;
          if (controller === null || !(target instanceof HTMLTextAreaElement)) return;
          if (target.closest('[data-slot="u2-edit-composer"]') !== null) return;
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          controller.update(source.getUserPrompts());
          controller.handleKeyDown(
            event,
            target.value,
            target.selectionStart ?? 0,
            target.selectionEnd ?? 0,
            (text) => composer.setText(text),
            // The composer renders its new text after this handler returns, and that render would
            // move the caret to the end, so the caret is set once the render has happened.
            (start, end) => {
              requestAnimationFrame(() => target.setSelectionRange(start, end));
            },
          );
        }}
      >
        {children}
      </div>
    </RecalledPromptContext.Provider>
  );
}
