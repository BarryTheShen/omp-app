import type { AppClient } from "@omp-app/client";
import { type ChatSearchMatch, ChatSearchPort } from "@omp-app/contracts";
import { useEffect, useState } from "react";

/** How long typing pauses before the search by meaning asks the server (the title matches show at once). */
export const MEANING_PAUSE_MS = 300;
/** How much of the matched passage a row shows. */
export const SNIPPET_CHARS = 160;

/** Where a search by meaning is: nothing typed, asking, off in Settings, its matches, or why it failed. */
export type MeaningSearch =
  | { readonly kind: "idle" }
  | { readonly kind: "searching" }
  | { readonly kind: "off" }
  | { readonly kind: "found"; readonly matches: readonly ChatSearchMatch[] }
  | { readonly kind: "failed"; readonly message: string };

const IDLE: MeaningSearch = { kind: "idle" };

/**
 * The chats closest in meaning to `query`, asked once typing pauses; nothing while `active` is false (the palette shut)
 * or nothing is typed. An answer to older words is dropped when newer ones were typed meanwhile.
 */
export function useMeaningSearch(client: AppClient, query: string, active = true): MeaningSearch {
  const [search, setSearch] = useState<MeaningSearch>(IDLE);
  const words = query.trim();
  useEffect(() => {
    if (!active || words === "") {
      setSearch(IDLE);
      return;
    }
    let alive = true;
    const port = client.port(ChatSearchPort);
    const timer = setTimeout(() => {
      setSearch({ kind: "searching" });
      port
        .state({})
        .then(async (state) => {
          if (!state.settings.enabled) return { kind: "off" } as const;
          const { matches } = await port.search({ query: words.slice(0, 1_000), limit: 20 });
          return { kind: "found", matches } as const;
        })
        .then(
          (next) => alive && setSearch(next),
          (failure: unknown) =>
            alive &&
            setSearch({
              kind: "failed",
              message: failure instanceof Error ? failure.message : String(failure),
            }),
        );
    }, MEANING_PAUSE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [client, words, active]);
  return search;
}

/** A piece of a snippet: marked when it is one of the typed words. */
export interface SnippetPart {
  readonly text: string;
  readonly marked: boolean;
}

/** The words worth marking: three letters or more, without repeats, longest first (so "release" wins over "lease"). */
function markable(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

const literal = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The part of a passage a row shows: about `SNIPPET_CHARS` characters around the first of the typed words it has (from
 * its start when it has none, as a match by meaning often shares no word), on one line, with each typed word marked.
 */
export function snippet(passage: string, query: string): SnippetPart[] {
  const text = passage.replace(/\s+/g, " ").trim();
  const words = markable(query);
  const pattern = words.length === 0 ? null : new RegExp(words.map(literal).join("|"), "giu");
  const first = pattern === null ? -1 : text.search(pattern);
  const start =
    first <= SNIPPET_CHARS / 3 ? 0 : text.lastIndexOf(" ", first - SNIPPET_CHARS / 3) + 1;
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  const cut = `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
  if (pattern === null) return [{ text: cut, marked: false }];
  const parts: SnippetPart[] = [];
  let at = 0;
  for (const found of cut.matchAll(pattern)) {
    const index = found.index ?? 0;
    if (index > at) parts.push({ text: cut.slice(at, index), marked: false });
    parts.push({ text: found[0], marked: true });
    at = index + found[0].length;
  }
  if (at < cut.length) parts.push({ text: cut.slice(at), marked: false });
  return parts;
}
