/**
 * Extensions' rows for the message box's menus (`extension_completions`). In omp's terminal an extension stacks an
 * autocomplete provider on the editor's own (`ctx.ui.addAutocompleteProvider`, `interactive-mode.ts:2885-2918`), for
 * example to offer notes from another app after an `@`. The app's menus list the folder's files and omp's commands
 * themselves, so here the extensions' providers stack on one that offers nothing, and the page shows their rows after its
 * own. Each row carries the text and caret the provider makes of the box when the row is taken.
 */
import type { AutocompleteProviderFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AutocompleteItem, AutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import type { ExtensionCompletion } from "@omp-app/contracts/chat-host";

/** At most this many rows; a provider that offers more is cut. */
const MAX_ROWS = 30;
/** A provider slower than this offers nothing for this keystroke. */
const PROVIDER_TIMEOUT_MS = 3_000;

const OFFERS_NOTHING: AutocompleteProvider = {
  getSuggestions: async () => null,
  applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
};

/** The extensions' providers stacked in the order they were added; a factory that throws or returns no provider is skipped, as omp does. */
export function stackProviders(
  factories: readonly AutocompleteProviderFactory[],
): AutocompleteProvider | null {
  let provider = OFFERS_NOTHING;
  for (const factory of factories) {
    try {
      const wrapped = factory(provider);
      if (
        typeof wrapped?.getSuggestions === "function" &&
        typeof wrapped.applyCompletion === "function"
      )
        provider = wrapped;
    } catch {
      // One broken extension must not take the others' rows away.
    }
  }
  return provider === OFFERS_NOTHING ? null : provider;
}

/** The box's text as the editor's lines, with the caret's line and column. */
function toLines(text: string, caret: number): { lines: string[]; line: number; col: number } {
  const lines = text.split("\n");
  const before = text.slice(0, caret).split("\n");
  return { lines, line: before.length - 1, col: (before.at(-1) ?? "").length };
}

/** The rows the stacked providers offer for this text and caret, each with the box it would leave. */
export async function extensionCompletions(
  provider: AutocompleteProvider | null,
  text: string,
  caret: number,
): Promise<readonly ExtensionCompletion[]> {
  if (provider === null) return [];
  const { lines, line, col } = toLines(text, caret);
  const abort = new AbortController();
  const timedOut = Promise.withResolvers<null>();
  const timer = setTimeout(() => {
    abort.abort();
    timedOut.resolve(null);
  }, PROVIDER_TIMEOUT_MS);
  let offered: { items: AutocompleteItem[]; prefix: string } | null;
  try {
    offered = await Promise.race([
      provider.getSuggestions(lines, line, col, abort.signal),
      timedOut.promise,
    ]);
  } catch {
    offered = null;
  } finally {
    clearTimeout(timer);
  }
  if (offered === null) return [];
  const rows: ExtensionCompletion[] = [];
  for (const item of offered.items.slice(0, MAX_ROWS)) {
    try {
      const after = provider.applyCompletion([...lines], line, col, item, offered.prefix);
      const afterText = after.lines.join("\n");
      const caretAfter =
        after.lines.slice(0, after.cursorLine).reduce((sum, row) => sum + row.length + 1, 0) +
        after.cursorCol;
      rows.push({
        label: item.label,
        ...(item.description ? { detail: item.description } : {}),
        text: afterText,
        caret: Math.min(Math.max(caretAfter, 0), afterText.length),
      });
    } catch {
      // A row the provider cannot apply is not offered.
    }
  }
  return rows;
}
