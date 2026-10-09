import {
  ComposerPrimitive,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
  unstable_useLiveCompletionAdapter,
} from "@assistant-ui/react";
import { useCallback, useMemo, useRef } from "react";
import type { ComposerTriggerProvider, ComposerTriggerSlotProps } from "../../U2/contract";
import type { TriggerCandidate, TriggerSearchResult } from "../contract";
import { TriggerKeyScope, useTriggerListLoading } from "../shared/trigger-keys";
import { detectEmojiTrigger } from "./emoji";
import type { LocalProvider, LocalTrigger } from "./provider";
import { detectInternalUrlTrigger } from "./urls";

interface LocalTriggerSlotProps extends ComposerTriggerSlotProps {
  readonly providers: readonly ComposerTriggerProvider[];
}

const URL_TRIGGER_CHARS = [
  "skill://",
  "rule://",
  "omp://",
  "local://",
  "memory://",
  "agent://",
  "artifact://",
  "issue://",
  "pr://",
] as const;

interface TriggerItemsResult {
  readonly items: readonly Unstable_TriggerItem[];
  readonly candidates: ReadonlyMap<string, TriggerCandidate>;
}

function resultItems(result: TriggerSearchResult, trigger: LocalTrigger): TriggerItemsResult {
  const candidates = new Map<string, TriggerCandidate>();
  const items: Unstable_TriggerItem[] = result.candidates.map((candidate) => {
    candidates.set(candidate.id, candidate);
    return {
      id: candidate.id,
      type: candidate.kind,
      label: candidate.label,
      ...(candidate.description ? { description: candidate.description } : {}),
      metadata: { insertText: candidate.insertText ?? `${trigger}${candidate.label} ` },
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

function directiveFormatter(trigger: LocalTrigger): Unstable_DirectiveFormatter {
  return {
    serialize(item) {
      const insertion = item.metadata?.insertText;
      return typeof insertion === "string" ? insertion.trimEnd() : `${trigger}${item.label}`;
    },
    parse(text) {
      return [{ kind: "text", text }];
    },
  };
}

function renderItems(
  items: readonly Unstable_TriggerItem[],
  trigger: LocalTrigger,
): React.ReactNode {
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

function triggerMatcher(text: string, trigger: LocalTrigger, cursorPosition: number) {
  if (trigger === ":") {
    const match = detectEmojiTrigger(text, cursorPosition);
    if (!match) return null;
    return { query: match.query, offset: match.range.start, endOffset: match.range.end };
  }
  const match = detectInternalUrlTrigger(text, cursorPosition);
  if (!match || match.scheme !== trigger.slice(0, -3)) return null;
  return {
    query: `${match.scheme}://${match.query}`,
    offset: match.range.start,
    endOffset: match.range.end,
  };
}

function isLocalProvider(provider: ComposerTriggerProvider): provider is LocalProvider {
  return "searchTyped" in provider && "kind" in provider && "source" in provider;
}

function providerForTrigger(
  providers: readonly ComposerTriggerProvider[],
  trigger: LocalTrigger,
): LocalProvider | undefined {
  for (const provider of providers) {
    if (provider.trigger === trigger && isLocalProvider(provider)) return provider;
    if (trigger !== ":" && isLocalProvider(provider) && provider.kind === "internal-url")
      return provider;
  }
  return undefined;
}

function LocalTriggerPopover({
  provider,
  trigger,
  onSelect,
}: {
  readonly provider: LocalProvider | undefined;
  readonly trigger: LocalTrigger;
  readonly onSelect: (candidate: TriggerCandidate) => void;
}) {
  const candidateMap = useRef<ReadonlyMap<string, TriggerCandidate>>(new Map());
  const fetcher = useCallback(
    async (query: string): Promise<readonly Unstable_TriggerItem[]> => {
      if (!provider || !("searchTyped" in provider)) return [];
      const result = await provider.searchTyped(query);
      const next = resultItems(result, trigger);
      candidateMap.current = next.candidates;
      return next.items;
    },
    [provider, trigger],
  );
  const completion = unstable_useLiveCompletionAdapter({
    fetcher,
    cacheKey: `${provider?.source ?? "none"}:${trigger}`,
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
  // A trigger the provider does not serve (issue:// without GitHub) opens no list: no search, no message.
  const served = provider.serves?.(trigger) ?? true;
  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char={trigger}
      matcher={(text, _char, cursorPosition) => triggerMatcher(text, trigger, cursorPosition)}
      adapter={served ? completion.adapter : undefined}
      isLoading={completion.isLoading}
      aria-label={trigger === ":" ? "Emoji suggestions" : "Link suggestions"}
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
/**
 * The emoji and link lists for one composer. They render inside the composer's shared trigger root (see
 * ComposerTriggers), so the composer's textarea can point at the highlighted emoji.
 */
export function LocalComposerSlot({ providers, onSelect, children }: LocalTriggerSlotProps) {
  return (
    <TriggerKeyScope className="relative">
      {children}
      <LocalTriggerPopover
        provider={providerForTrigger(providers, ":")}
        trigger=":"
        onSelect={onSelect}
      />
      {URL_TRIGGER_CHARS.map((trigger) => (
        <LocalTriggerPopover
          key={trigger}
          provider={providerForTrigger(providers, trigger)}
          trigger={trigger}
          onSelect={onSelect}
        />
      ))}
    </TriggerKeyScope>
  );
}

/** D2.5's local trigger slot on its own: it opens its own trigger root, for a composer that no other slot wraps. */
export function LocalTriggerSlot(props: LocalTriggerSlotProps) {
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <LocalComposerSlot {...props} />
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}
