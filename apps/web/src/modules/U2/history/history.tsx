import { useAui } from "@assistant-ui/react";
import { type ReactNode, useEffect, useRef } from "react";

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

/** R0.2-backed, in-memory navigation state; it never creates a second durable history store. */
export class PromptHistoryController {
  private prompts: readonly string[] = [];
  private index = -1;
  private draft: string | null = null;

  public constructor(source: PromptHistorySource) {
    this.prompts = source.getUserPrompts();
  }

  public update(prompts: readonly string[]): void {
    this.prompts = prompts;
    if (this.index >= prompts.length) this.index = -1;
  }

  public snapshot(): PromptHistorySnapshot {
    return { prompts: this.prompts, index: this.index, draft: this.draft };
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
    event: {
      readonly key: string;
      readonly altKey: boolean;
      readonly ctrlKey: boolean;
      readonly metaKey: boolean;
      readonly shiftKey: boolean;
      readonly nativeEvent?: { readonly isComposing?: boolean };
      preventDefault(): void;
    },
    text: string,
    selectionStart: number,
    selectionEnd: number,
    setText: (text: string) => void,
    setSelection: (start: number, end: number) => void,
  ): boolean {
    if (
      event.nativeEvent?.isComposing === true ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return false;
    if (event.key === "ArrowUp" && selectionStart === 0 && selectionEnd === 0) {
      if (this.prompts.length === 0) return false;
      if (this.index < 0) this.draft = text;
      this.index = Math.min(this.index + 1, this.prompts.length - 1);
      const prompt = this.prompts[this.prompts.length - 1 - this.index];
      if (prompt === undefined) return false;
      event.preventDefault();
      setText(prompt);
      setSelection(0, 0);
      return true;
    }
    if (
      event.key === "ArrowDown" &&
      this.index >= 0 &&
      selectionStart === text.length &&
      selectionEnd === text.length
    ) {
      this.index -= 1;
      event.preventDefault();
      if (this.index < 0) {
        const draft = this.draft ?? "";
        this.draft = null;
        setText(draft);
        setSelection(draft.length, draft.length);
      } else {
        const prompt = this.prompts[this.prompts.length - 1 - this.index] ?? "";
        setText(prompt);
        setSelection(prompt.length, prompt.length);
      }
      return true;
    }
    return false;
  }
}

/** Attach Up/Down history behavior around U2's composer input without taking focus ownership. */
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
  return (
    <div
      data-slot="u2-history-slot"
      onKeyDownCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLTextAreaElement)) return;
        controllerRef.current?.handleKeyDown(
          event,
          target.value,
          target.selectionStart ?? 0,
          target.selectionEnd ?? 0,
          (text) => composer.setText(text),
          (start, end) => target.setSelectionRange(start, end),
        );
      }}
    >
      {children}
    </div>
  );
}
