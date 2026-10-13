import {
  ComposerPrimitive,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
  unstable_useLiveCompletionAdapter,
  unstable_useTriggerPopoverScopeContext,
  useAui,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  ComposerTriggerCandidate,
  ComposerTriggerProvider,
  ComposerTriggerSlotProps,
} from "../../U2/contract";
import type { MentionProvider, TriggerCandidate, TriggerSearchResult } from "../contract";
import {
  TriggerKeyScope,
  useComposerTextarea,
  useTriggerListLoading,
} from "../shared/trigger-keys";
import {
  detectMentionTrigger,
  executePromptAction,
  expandMention,
  isPromptAction,
} from "./mentions";
import { type EditKind, kindOfTypedText, removePromptToken, TypingHistory } from "./prompt-actions";

interface TriggerItemsResult {
  readonly items: readonly Unstable_TriggerItem[];
  readonly candidates: ReadonlyMap<string, TriggerCandidate>;
  /** Why the search could not answer, in plain words. It is shown in the list, never as a row to choose. */
  readonly status: string | undefined;
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
  return { items, candidates, status: result.error?.error.message };
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

function renderItems(
  items: readonly Unstable_TriggerItem[],
  trigger: "@" | "#",
  status: string | undefined,
): React.ReactNode {
  return (
    <div className="border-border bg-popover text-popover-foreground shadow-overlay max-h-72 min-w-64 overflow-y-auto rounded-lg border p-1">
      {status !== undefined && (
        <p role="status" className="text-muted-foreground px-3 py-2 text-sm">
          {status}
        </p>
      )}
      {items.length === 0 && status === undefined ? (
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

/** Copies a prompt action's text and says what happened; a refused copy is reported, never hidden. */
async function copyPromptText(
  copyText: string,
  copied: string,
  notify: (message: string) => void,
  fail: (message: string) => void,
): Promise<void> {
  if (copyText === "") {
    notify("There is nothing to copy.");
    return;
  }
  try {
    await navigator.clipboard.writeText(copyText);
    notify(copied);
  } catch {
    fail("The browser would not write to the clipboard.");
  }
}

/** Hands the popover's selections to `runAction`: a `#` action row it takes is not inserted as text. */
function PromptActionOverride({
  runAction,
}: {
  readonly runAction: (item: Unstable_TriggerItem) => boolean;
}) {
  const { registerSelectItemOverride } = unstable_useTriggerPopoverScopeContext();
  useEffect(() => registerSelectItemOverride(runAction), [registerSelectItemOverride, runAction]);
  return null;
}

/** The kind of the edit a key is about to make: a character typed, one character deleted, or anything else. */
function editKindOf(event: InputEvent, input: HTMLTextAreaElement): EditKind {
  if (input.selectionStart !== input.selectionEnd) return "other";
  if (event.inputType === "insertLineBreak") return "space";
  if (event.inputType === "insertText") return kindOfTypedText(event.data ?? "");
  if (event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward") {
    return "delete";
  }
  return "other";
}

function TriggerPopoverView({
  provider,
  trigger,
  onSelect,
  notify,
  fail,
}: {
  readonly provider: MentionProvider | undefined;
  readonly trigger: "@" | "#";
  readonly onSelect: (candidate: TriggerCandidate) => void;
  readonly notify: (message: string) => void;
  readonly fail: (message: string) => void;
}) {
  const candidateMap = useRef<ReadonlyMap<string, TriggerCandidate>>(new Map());
  // Why the last search could not answer: shown in the list, never as a row to choose.
  const [status, setStatus] = useState<string | undefined>(undefined);
  const fetcher = useCallback(
    async (query: string): Promise<readonly Unstable_TriggerItem[]> => {
      if (!provider) return [];
      const result = await provider.searchTyped(query);
      const next = resultItems(result, trigger);
      candidateMap.current = next.candidates;
      setStatus(next.status);
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
  const aui = useAui();
  const composerTextarea = useComposerTextarea();
  // What the person typed, for Undo on a `#` action row. Only the # popover keeps it. Each key is reported before the
  // text changes (`beforeinput`), so the steps follow the keys, not the composer's updates (see TypingHistory). Text an
  // action changes is never a key, so it is never recorded.
  const [history] = useState(() => new TypingHistory());
  useEffect(() => {
    if (trigger !== "#") return undefined;
    const onBeforeInput = (event: InputEvent) => {
      const input = composerTextarea();
      if (input === null || event.target !== input) return;
      history.observeEdit(input.value, editKindOf(event, input));
    };
    document.addEventListener("beforeinput", onBeforeInput, true);
    return () => document.removeEventListener("beforeinput", onBeforeInput, true);
  }, [composerTextarea, history, trigger]);
  // A GitHub row replaces the reference at the caret with its link, the typed `pr` or `issue` word included: the
  // directive would leave that word in front of the link. The row is done here only while the caret is on its #.
  const insertReference = useCallback(
    (candidate: TriggerCandidate): boolean => {
      const textarea = composerTextarea();
      if (textarea === null) return true;
      const token = detectMentionTrigger(textarea.value, textarea.selectionStart);
      if (token?.trigger !== "#") return true;
      const expanded = expandMention(textarea.value, token, candidate);
      if (expanded.kind !== "expanded") return true;
      flushSync(() => aui.composer.setText(expanded.text));
      textarea.setSelectionRange(expanded.cursor, expanded.cursor);
      textarea.focus();
      onSelect(candidate);
      return true;
    },
    [aui, composerTextarea, onSelect],
  );
  // A `#` action row runs on the token at the caret and inserts nothing. A GitHub row goes to insertReference.
  const runAction = useCallback(
    (item: Unstable_TriggerItem): boolean => {
      const candidate = candidateMap.current.get(item.id);
      if (candidate?.kind === "github") return insertReference(candidate);
      const action = candidate?.metadata?.action;
      if (!isPromptAction(action)) return false;
      const textarea = composerTextarea();
      if (textarea === null) return true;
      const token = detectMentionTrigger(textarea.value, textarea.selectionStart);
      if (token?.trigger !== "#") return true;
      const removed = removePromptToken(textarea.value, token.range);
      let next = removed;
      if (action === "undo") {
        const previous = history.undo(removed.text);
        if (previous === undefined) notify("There is nothing to undo.");
        else next = { text: previous, cursor: Math.min(removed.cursor, previous.length) };
      } else {
        const effect = executePromptAction(action, removed.text, removed.cursor);
        if (effect.copyText !== undefined) {
          const copied =
            action === "copy-current-line" ? "Copied the current line." : "Copied the prompt.";
          void copyPromptText(effect.copyText, copied, notify, fail);
        }
        next = { text: effect.text, cursor: effect.cursor };
      }
      flushSync(() => aui.composer.setText(next.text));
      textarea.setSelectionRange(next.cursor, next.cursor);
      textarea.focus();
      return true;
    },
    [aui, composerTextarea, fail, history, insertReference, notify],
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
      {trigger === "#" && <PromptActionOverride runAction={runAction} />}
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) => renderItems(items, trigger, status)}
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
/** The mention lists' props: the composer's trigger slot props, and where an action row reports what it did. */
interface MentionComposerSlotProps extends ComposerTriggerSlotProps {
  readonly notify: (message: string) => void;
  readonly fail: (message: string) => void;
}

/** The file and GitHub lists for one composer. They render inside the composer's shared trigger root (see ComposerTriggers). */
export function MentionComposerSlot({
  providers,
  onSelect,
  notify,
  fail,
  children,
}: MentionComposerSlotProps) {
  return (
    <TriggerKeyScope className="relative">
      {children}
      <TriggerPopoverView
        provider={findMentionProvider(providers, "@")}
        trigger="@"
        onSelect={onSelect}
        notify={notify}
        fail={fail}
      />
      <TriggerPopoverView
        provider={findMentionProvider(providers, "#")}
        trigger="#"
        onSelect={onSelect}
        notify={notify}
        fail={fail}
      />
    </TriggerKeyScope>
  );
}

export type { ComposerTriggerCandidate };
