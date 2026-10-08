import {
  ComposerPrimitive,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
  unstable_useLiveCompletionAdapter,
} from "@assistant-ui/react";
import { type KeyboardEvent, type ReactNode, useCallback, useMemo, useRef } from "react";
import type {
  ComposerTriggerCandidate,
  ComposerTriggerProvider,
  ComposerTriggerSlotProps,
} from "../../U2/contract";
import type { TriggerCandidate, TriggerSearchResult } from "../contract";
import type { SlashCommandProvider } from "./provider";

/** The typed text from the start of the message up to the caret, on one line: `/name` or `/name args`. */
const SLASH_TYPING = /^\/\S*(?:[ \t][^\n]*)?$/u;

interface TriggerItemsResult {
  readonly items: readonly Unstable_TriggerItem[];
  readonly candidates: ReadonlyMap<string, TriggerCandidate>;
}

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

function renderItems(items: readonly Unstable_TriggerItem[], status: string | null): ReactNode {
  return (
    <div className="border-border bg-popover text-popover-foreground shadow-overlay max-h-72 min-w-64 max-w-[min(28rem,90vw)] overflow-y-auto rounded-lg border p-1">
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
              className="data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground flex w-full flex-col items-start rounded-md px-3 py-2 text-start text-sm outline-none"
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

function selectActiveTriggerItem(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== "Enter" && event.key !== "Tab") return;
  if (!(event.target instanceof HTMLTextAreaElement)) return;
  const activeId = event.target.getAttribute("aria-activedescendant");
  if (!activeId) return;
  const item = document.getElementById(activeId);
  if (!(item instanceof HTMLElement)) return;
  event.preventDefault();
  event.stopPropagation();
  item.click();
}

function SlashPopover({
  provider,
  onSelect,
}: {
  readonly provider: SlashCommandProvider | undefined;
  readonly onSelect: (candidate: ComposerTriggerCandidate) => void;
}) {
  const candidateMap = useRef<ReadonlyMap<string, TriggerCandidate>>(new Map());
  const status = useRef<string | null>(null);
  // True while arguments follow a command and nothing matches them: no list, so Enter sends the message.
  const quiet = useRef(false);
  const fetcher = useCallback(
    async (query: string): Promise<readonly Unstable_TriggerItem[]> => {
      if (!provider) return [];
      const result = await provider.searchTyped(query);
      const next = resultItems(result);
      candidateMap.current = next.candidates;
      status.current = statusLine(result);
      quiet.current = /\s/u.test(query) && next.items.length === 0 && status.current === null;
      return next.items;
    },
    [provider],
  );
  const completion = unstable_useLiveCompletionAdapter({
    fetcher,
    cacheKey: "slash:/",
    debounceMs: 60,
    enabled: provider !== undefined,
  });
  const formatter = useMemo(() => directiveFormatter(), []);
  const handleInserted = useCallback(
    (item: Unstable_TriggerItem) => {
      const candidate = candidateMap.current.get(item.id);
      if (candidate) onSelect(candidate);
    },
    [onSelect],
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
        {(items) => (quiet.current ? null : renderItems(items, status.current))}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

/**
 * The slash list for a composer that already sits inside a trigger root (the app's composer does: the
 * mention slot owns the root). The composer and the list must share one root, because the composer reads
 * the open popover's keyboard highlight from its nearest root; a second root would hide it.
 */
export function SlashComposerSlot({ providers, onSelect, children }: ComposerTriggerSlotProps) {
  const provider = providers.find(isSlashProvider);
  return (
    <div className="relative" onKeyDownCapture={selectActiveTriggerItem}>
      {children}
      <SlashPopover provider={provider} onSelect={onSelect} />
    </div>
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
