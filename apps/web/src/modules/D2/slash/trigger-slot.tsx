import {
  ComposerPrimitive,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
  unstable_useLiveCompletionAdapter,
} from "@assistant-ui/react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import type {
  ComposerTriggerCandidate,
  ComposerTriggerProvider,
  ComposerTriggerSlotProps,
} from "../../U2/contract";
import type { TriggerCandidate, TriggerSearchResult } from "../contract";
import {
  type KeptEnterAnswer,
  TriggerKeyScope,
  useSendAfterChoose,
  useTriggerListLoading,
} from "../shared/trigger-keys";
import type { SlashCommandProvider } from "./provider";

/** The typed text from the start of the message up to the caret, on one line: `/name` or `/name args`. */
const SLASH_TYPING = /^\/\S*(?:[ \t][^\n]*)?$/u;

/** The popover's box: the rows, the no-match line and the loading line share it, so its look is set in one place. */
const POPOVER_BOX =
  "bg-popover text-popover-foreground border-foreground/10 max-h-72 min-w-64 max-w-[min(28rem,90vw)] overflow-y-auto rounded-surface border p-1";

interface TriggerItemsResult {
  readonly items: readonly Unstable_TriggerItem[];
  readonly candidates: ReadonlyMap<string, TriggerCandidate>;
}

/** The text each list answer was fetched for, keyed by the answer's items: a row on screen answers that text. */
type AnswerQueries = WeakMap<readonly Unstable_TriggerItem[], string>;

function resultItems(result: TriggerSearchResult): TriggerItemsResult {
  const candidates = new Map<string, TriggerCandidate>();
  const items: Unstable_TriggerItem[] = result.candidates.map((candidate) => {
    candidates.set(candidate.id, candidate);
    const meta = candidate.metadata ?? {};
    const sourceText = typeof meta.sourceLabel === "string" ? meta.sourceLabel : "";
    const hint = typeof meta.argumentHint === "string" ? meta.argumentHint : undefined;
    return {
      id: candidate.id,
      type: candidate.kind,
      label: candidate.label,
      ...(candidate.description ? { description: candidate.description } : {}),
      metadata: {
        insertText: candidate.insertText ?? `${candidate.label} `,
        sourceLabel: sourceText,
        ...(hint === undefined ? {} : { argumentHint: hint }),
      },
    };
  });
  return { items, candidates };
}

/** The plain-English line for a list that could not load or is unavailable; null when it is fine. */
function statusLine(result: TriggerSearchResult): string | null {
  return result.error ? result.error.error.message : null;
}

function directiveFormatter(): Unstable_DirectiveFormatter {
  return {
    serialize(item) {
      const insertion = item.metadata?.insertText;
      return typeof insertion === "string" ? insertion.trimEnd() : item.label;
    },
    parse(text) {
      return [{ kind: "text", text }];
    },
  };
}

/** An empty list that no search has answered is still loading, and the popover says so. "No matching commands." is said only after a search has answered with none. */
function awaitsAnswer(items: readonly Unstable_TriggerItem[], answers: AnswerQueries): boolean {
  return items.length === 0 && answers.get(items) === undefined;
}

function renderItems(
  items: readonly Unstable_TriggerItem[],
  status: string | null,
  answersQuery: string | undefined,
): ReactNode {
  return (
    <div className={POPOVER_BOX}>
      {items.length === 0 ? (
        <p className="text-muted-foreground px-3 py-2 text-sm">
          {status ?? "No matching commands."}
        </p>
      ) : (
        items.map((item, index) => {
          const meta = item.metadata ?? {};
          const sourceText = typeof meta.sourceLabel === "string" ? meta.sourceLabel : "";
          const hint = typeof meta.argumentHint === "string" ? meta.argumentHint : undefined;
          return (
            <ComposerPrimitive.Unstable_TriggerPopoverItem
              key={item.id}
              item={item}
              index={index}
              data-answers={answersQuery}
              className="data-[highlighted]:bg-muted data-[highlighted]:text-foreground flex w-full cursor-pointer flex-col items-start rounded-sm px-2 py-1.5 text-start text-sm outline-none select-none"
            >
              <span className="flex w-full min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate font-medium">{item.label}</span>
                {sourceText !== "" && (
                  <span className="border-border bg-muted text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-xs">
                    {sourceText}
                  </span>
                )}
              </span>
              {item.description && (
                <span className="text-muted-foreground w-full text-xs">{item.description}</span>
              )}
              {hint !== undefined && (
                <span className="text-muted-foreground w-full text-xs">
                  {hint === "arguments" ? "Takes arguments" : `Arguments: ${hint}`}
                </span>
              )}
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
          );
        })
      )}
      {items.length > 0 && status !== null && (
        <p
          role="status"
          className="text-muted-foreground border-border mt-1 border-t px-3 py-2 text-xs"
        >
          {status}
        </p>
      )}
    </div>
  );
}

function slashMatcher(text: string, cursorPosition: number) {
  const typed = text.slice(0, cursorPosition);
  if (!SLASH_TYPING.test(typed)) return null;
  // Replace the whole first word when the caret is inside it; otherwise only what was typed up to the caret.
  const firstWord = /^\/\S*/u.exec(text)?.[0] ?? typed;
  const endOffset = typed.length <= firstWord.length ? firstWord.length : cursorPosition;
  return { query: typed, offset: 0, endOffset };
}

function isSlashProvider(provider: ComposerTriggerProvider): provider is SlashCommandProvider {
  return provider.trigger === "/" && "searchTyped" in provider && "catalog" in provider;
}

function SlashPopover({
  provider,
  onSelect,
  answers,
}: {
  readonly provider: SlashCommandProvider | undefined;
  readonly onSelect: (candidate: ComposerTriggerCandidate) => void;
  readonly answers: AnswerQueries;
}) {
  const candidateMap = useRef<ReadonlyMap<string, TriggerCandidate>>(new Map());
  const status = useRef<string | null>(null);
  // True while arguments follow a command and nothing matches them: no list, so Enter sends the message.
  const quiet = useRef(false);
  // Whether the list's first command is exactly the text typed: only then does an Enter kept while it loaded choose it.
  const typedIsFirst = useRef(false);
  const [, redraw] = useState(0);
  const fetcher = useCallback(
    async (query: string): Promise<readonly Unstable_TriggerItem[]> => {
      if (!provider) return [];
      const result = await provider.searchTyped(query);
      const next = resultItems(result);
      answers.set(next.items, query);
      candidateMap.current = next.candidates;
      status.current = statusLine(result);
      quiet.current = /\s/u.test(query) && next.items.length === 0 && status.current === null;
      typedIsFirst.current = next.items[0]?.label === query;
      return next.items;
    },
    [provider, answers],
  );
  const completion = unstable_useLiveCompletionAdapter({
    fetcher,
    cacheKey: "slash:/",
    debounceMs: 60,
    enabled: provider !== undefined,
  });
  // A kept Enter chooses only the command whose exact name was typed; otherwise the list was never seen and the key is dropped (issue 818).
  const answerKeptEnter = useCallback(
    (): KeptEnterAnswer => (typedIsFirst.current ? "choose" : "drop"),
    [],
  );
  useTriggerListLoading(completion.isLoading, answerKeptEnter);
  const sendAfterChoose = useSendAfterChoose();
  const formatter = useMemo(() => directiveFormatter(), []);
  const handleInserted = useCallback(
    (item: Unstable_TriggerItem) => {
      const candidate = candidateMap.current.get(item.id);
      if (!candidate) return;
      onSelect(candidate);
      // A command with no arguments runs when it is chosen, by Enter or by a click, as omp's TUI does: it applies and
      // submits the highlighted slash command (packages/tui/src/components/editor.ts:1932-1966). Its old option stays
      // highlighted until the next search answers, so the list goes quiet first and the send follows after that.
      // A command with arguments keeps its name in the composer, so the arguments can be typed.
      if (typeof candidate.metadata?.argumentHint !== "string") {
        quiet.current = true;
        redraw((count) => count + 1);
        sendAfterChoose();
      }
    },
    [onSelect, sendAfterChoose],
  );
  if (!provider) return null;
  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      matcher={(text, _char, cursorPosition) => slashMatcher(text, cursorPosition)}
      adapter={completion.adapter}
      isLoading={completion.isLoading}
      aria-label="Slash commands"
      className="absolute bottom-full left-0 z-30 mb-2"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive
        formatter={formatter}
        onInserted={handleInserted}
      />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) => {
          if (quiet.current) return null;
          // Until the list has answered, the popover says so. It is open on the keystroke, so the line shows with it.
          if (awaitsAnswer(items, answers)) {
            return (
              <div className={POPOVER_BOX}>
                <p role="status" className="text-muted-foreground px-3 py-2 text-sm">
                  Loading commands…
                </p>
              </div>
            );
          }
          return renderItems(items, status.current, answers.get(items));
        }}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

/**
 * The slash list for one composer. It renders inside the composer's shared trigger root (see ComposerTriggers),
 * so the composer's textarea can point at the highlighted command.
 */
export function SlashComposerSlot({ providers, onSelect, children }: ComposerTriggerSlotProps) {
  const provider = providers.find(isSlashProvider);
  const [answers] = useState<AnswerQueries>(() => new WeakMap());
  // A row answers the text it was fetched for. One that is not the text at the caret is not chosen (see TriggerKeyScope).
  const rowAnswersText = useCallback((textarea: HTMLTextAreaElement, row: HTMLElement): boolean => {
    const typed = slashMatcher(textarea.value, textarea.selectionStart ?? textarea.value.length);
    return typed === null || row.getAttribute("data-answers") === typed.query;
  }, []);
  return (
    <TriggerKeyScope
      className="relative"
      isCurrentRow={rowAnswersText}
      submitWhenLoading={(textarea) => /\s/u.test(textarea.value)}
    >
      {children}
      <SlashPopover provider={provider} onSelect={onSelect} answers={answers} />
    </TriggerKeyScope>
  );
}

/** The same slot with its own trigger root, for a composer that no other trigger slot wraps. */
export function SlashTriggerSlot(props: ComposerTriggerSlotProps) {
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <SlashComposerSlot {...props} />
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}
