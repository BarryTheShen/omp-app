import type { TriggerCandidate, TriggerSource } from "../contract";

/** One entry the `/` list can show: an omp command, an MCP prompt, or an app command. */
export interface SlashListEntry {
  readonly name: string;
  readonly source: TriggerSource;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly input?: { readonly hint?: string };
  readonly subcommands?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly usage?: string;
  }[];
}

const SOURCE_LABELS: Record<TriggerSource, string> = {
  builtin: "Built-in",
  extension: "Extension",
  skill: "Skill",
  custom: "Custom",
  mcp_prompt: "MCP prompt",
  file: "Prompt file",
  client: "App",
  "a1.file-search": "Workspace file",
  "a1.github-refs": "GitHub",
  "a1.url-catalog": "Internal link",
};

const MAX_CANDIDATES = 200;
const MAX_TEXT = 2_000;

/** The word a badge shows for where a command comes from, in plain English. */
export function sourceLabel(source: TriggerSource): string {
  return SOURCE_LABELS[source];
}

/**
 * Ranks entries for what was typed after the slash. Without a space the first word matches a name or an
 * alias, and the commands are listed. Once a space follows, only the command whose name or alias is exactly
 * that word lists its subcommands, filtered by whatever comes after the space; a command with none, or a word
 * that names no command exactly, lists nothing.
 */
export function rankSlashEntries(
  entries: readonly SlashListEntry[],
  typed: string,
): readonly TriggerCandidate[] {
  const body = typed.replace(/^\/+/u, "");
  const head = /^\S*/u.exec(body)?.[0] ?? "";
  const spaced = body.length > head.length;
  const commandQuery = head.toLocaleLowerCase();
  const subquery = body.slice(head.length).trim().toLocaleLowerCase();
  if (spaced && commandQuery === "") return [];
  const ranked: Array<{
    readonly score: number;
    readonly index: number;
    readonly candidate: TriggerCandidate;
  }> = [];
  const seen = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const names = [entry.name, ...(entry.aliases ?? [])];
    if (spaced) {
      // As in omp, only the command whose name or alias is exactly the word before the space lists its subcommands.
      if (!names.some((name) => name.toLocaleLowerCase() === commandQuery)) continue;
      for (const subcommand of entry.subcommands ?? []) {
        const subScore = commandTextScore(subcommand.name, subquery);
        if (subScore === null) continue;
        const candidate = subcommandCandidate(entry, subcommand, seen);
        if (candidate) ranked.push({ score: subScore, index, candidate });
      }
      continue;
    }
    const commandScore = bestScore(names, commandQuery);
    if (commandScore === null) continue;
    const candidate = commandCandidate(entry, seen);
    if (candidate) ranked.push({ score: commandScore, index, candidate });
  }

  // The browser catalog has no command-usage counts; with omp's default usage of zero, ties keep catalog order.
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked.slice(0, MAX_CANDIDATES).map(({ candidate }) => candidate);
}

function commandCandidate(entry: SlashListEntry, seen: Set<string>): TriggerCandidate | undefined {
  const id = `slash:${entry.source}:${entry.name}`;
  if (seen.has(id)) return undefined;
  seen.add(id);
  const hint = entry.input?.hint;
  return {
    id,
    kind: "slash",
    source: entry.source,
    label: `/${entry.name}`,
    ...(entry.description ? { description: entry.description.slice(0, MAX_TEXT) } : {}),
    insertText: `/${entry.name} `,
    metadata: {
      sourceLabel: sourceLabel(entry.source),
      ...(hint ? { argumentHint: hint.slice(0, MAX_TEXT) } : {}),
      ...(entry.aliases && entry.aliases.length > 0 ? { aliases: [...entry.aliases] } : {}),
    },
  };
}

function subcommandCandidate(
  entry: SlashListEntry,
  subcommand: NonNullable<SlashListEntry["subcommands"]>[number],
  seen: Set<string>,
): TriggerCandidate | undefined {
  const id = `slash:${entry.source}:${entry.name}:${subcommand.name}`;
  if (seen.has(id)) return undefined;
  seen.add(id);
  const usage = subcommand.usage ? `Usage: ${subcommand.usage}` : undefined;
  const description = [subcommand.description, usage].filter(Boolean).join(" · ");
  return {
    id,
    kind: "slash",
    source: entry.source,
    label: `/${entry.name} ${subcommand.name}`,
    ...(description ? { description: description.slice(0, MAX_TEXT) } : {}),
    insertText: `/${entry.name} ${subcommand.name} `,
    metadata: {
      sourceLabel: sourceLabel(entry.source),
      subcommand: subcommand.name,
    },
  };
}

function bestScore(values: readonly string[], query: string): number | null {
  let best: number | null = null;
  for (const value of values) {
    const score = commandTextScore(value, query);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

/**
 * Mirrors omp's name/alias ranking: exact, prefix, then subsequence. Description matching is intentionally omitted:
 * command descriptions are display text and must not be parsed or searched by the browser (AP4).
 */
function commandTextScore(value: string, query: string): number | null {
  const normalized = value.toLocaleLowerCase();
  if (query.length === 0) return 1;
  if (normalized === query) return 1_000;
  if (normalized.startsWith(query)) return 900;
  return subsequenceScore(query, normalized);
}

/** omp's subsequence tiers: substring, tight subsequence, and gaps penalized by five points. */
function subsequenceScore(query: string, target: string): number | null {
  if (query.length > target.length) return null;
  if (target.startsWith(query)) return 80;
  if (target.includes(query)) return 60;
  let queryIndex = 0;
  let gaps = 0;
  let lastMatchIndex = -1;
  for (let index = 0; index < target.length && queryIndex < query.length; index += 1) {
    if (target[index] !== query[queryIndex]) continue;
    if (lastMatchIndex >= 0 && index - lastMatchIndex > 1) gaps += 1;
    lastMatchIndex = index;
    queryIndex += 1;
  }
  return queryIndex === query.length ? Math.max(1, 40 - gaps * 5) : null;
}
