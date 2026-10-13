import {
  ComposerPrimitive,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
  unstable_useLiveCompletionAdapter,
} from "@assistant-ui/react";
import { useCallback, useMemo, useRef } from "react";
import type {
  ComposerTriggerCandidate,
  ComposerTriggerProvider,
  ComposerTriggerSlotProps,
} from "../../U2/contract";
import type { MentionProvider, TriggerCandidate, TriggerSearchResult } from "../contract";
import { TriggerKeyScope, useTriggerListLoading } from "../shared/trigger-keys";
import { detectMentionTrigger } from "./mentions";

interface TriggerItemsResult {
  readonly items: readonly Unstable_TriggerItem[];
  readonly candidates: ReadonlyMap<string, TriggerCandidate>;
}

function resultItems(result: TriggerSearchResult, trigger: "@" | "#"): TriggerItemsResult {
  const candidates = new Map<string, TriggerCandidate>();
  const items: Unstable_TriggerItem[] = result.candidates.map((candidate) => {
    candidates.set(candidate.id, candidate);
    return {
      id: candidate.id,
      type: candidate.kind,
      label: candidate.label,
      ...(candidate.description ? { description: candidate.description } : {}),
      metadata: {
        insertText: candidate.insertText ?? `${trigger}${candidate.label} `,
      },
    };
  });
  if (result.error) {
    const id = `${trigger}:state:${result.error.state}`;
    items.push({
      id,
      type: "state",
      label: result.error.error.message,
      description: result.error.state === "unavailable" ? "Unavailable" : "Search failed",
      metadata: { insertText: "" },
    });
  }
  return { items, candidates };
}

function directiveFormatter(trigger: "@" | "#"): Unstable_DirectiveFormatter {
  return {
    serialize(item) {
      const insertion = item.metadata?.insertText;
      if (typeof insertion === "string") return insertion.trimEnd();
      return `${trigger}${item.label}`;
    },
    parse(text) {
      return [{ kind: "text", text }];
    },
  };
}

function renderItems(items: readonly Unstable_TriggerItem[], trigger: "@" | "#"): React.ReactNode {
  return (
    <div className="border-border bg-popover text-popover-foreground shadow-overlay max-h-72 min-w-64 overflow-y-auto rounded-lg border p-1">
      {items.length === 0 ? (
        <p className="text-muted-foreground px-3 py-2 text-sm">No matches</p>
      ) : (
        items.map((item, index) => (
          <ComposerPrimitive.Unstable_TriggerPopoverItem
            key={`${trigger}-${item.id}`}
            item={item}
            index={index}
            className="data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground flex w-full flex-col items-start rounded-md px-3 py-2 text-start text-sm outline-none"
          >
            <span className="font-medium">{item.label}</span>
            {item.description && (
              <span className="text-muted-foreground text-xs">{item.description}</span>
            )}
          </ComposerPrimitive.Unstable_TriggerPopoverItem>
        ))
      )}
    </div>
  );
}

function hashMatcher(text: string, triggerChar: string, cursorPosition: number) {
  if (triggerChar !== "#") return null;
  const match = detectMentionTrigger(text, cursorPosition);
  if (match?.trigger !== "#") return null;
  const prefix =
    match.githubKind === "pull-request" ? "pr " : match.githubKind === "issue" ? "issue " : "";
  return {
    query: `${prefix}${match.query}`,
    offset: match.range.start,
    endOffset: match.range.end,
  };
}

function TriggerPopoverView({
  provider,
  trigger,
  onSelect,
}: {
  readonly provider: MentionProvider | undefined;
  readonly trigger: "@" | "#";
  readonly onSelect: (candidate: TriggerCandidate) => void;
}) {
  const candidateMap = useRef<ReadonlyMap<string, TriggerCandidate>>(new Map());
  const fetcher = useCallback(
    async (query: string): Promise<readonly Unstable_TriggerItem[]> => {
      if (!provider) return [];
      const result = await provider.searchTyped(query);
      const next = resultItems(result, trigger);
      candidateMap.current = next.candidates;
      return next.items;
    },
    [provider, trigger],
  );
  const completion = unstable_useLiveCompletionAdapter({
    fetcher,
    cacheKey: `${provider?.source ?? "none"}:${provider?.kind ?? "none"}:${trigger}`,
    debounceMs: 60,
    enabled: provider !== undefined,
  });
  useTriggerListLoading(completion.isLoading);
  const formatter = useMemo(() => directiveFormatter(trigger), [trigger]);
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
      char={trigger}
      matcher={trigger === "#" ? hashMatcher : undefined}
      adapter={completion.adapter}
      isLoading={completion.isLoading}
      aria-label={trigger === "@" ? "File suggestions" : "GitHub suggestions"}
      className="absolute bottom-full left-0 z-30 mb-2"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive
        formatter={formatter}
        onInserted={handleInserted}
      />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) => renderItems(items, trigger)}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

function isMentionProvider(provider: ComposerTriggerProvider): provider is MentionProvider {
  return "kind" in provider && "source" in provider && "searchTyped" in provider;
}

function findMentionProvider(
  providers: readonly ComposerTriggerProvider[],
  trigger: "@" | "#",
): MentionProvider | undefined {
  for (const provider of providers) {
    if (provider.trigger === trigger && isMentionProvider(provider)) return provider;
  }
  return undefined;
}
/** The file and GitHub lists for one composer. They render inside the composer's shared trigger root (see ComposerTriggers). */
export function MentionComposerSlot({ providers, onSelect, children }: ComposerTriggerSlotProps) {
  return (
    <TriggerKeyScope className="relative">
      {children}
      <TriggerPopoverView
        provider={findMentionProvider(providers, "@")}
        trigger="@"
        onSelect={onSelect}
      />
      <TriggerPopoverView
        provider={findMentionProvider(providers, "#")}
        trigger="#"
        onSelect={onSelect}
      />
    </TriggerKeyScope>
  );
}

/**
 * Composes D2's host-backed mention providers with U2's ComposerSurface. Assistant-ui owns the
 * trigger range, caret replacement, keyboard navigation, and Escape/focus behavior.
 */
export function MentionTriggerSlot(props: ComposerTriggerSlotProps) {
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <MentionComposerSlot {...props} />
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}

export type { ComposerTriggerCandidate };
