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
  const ranked: Array<{ readonly score: number; readonly candidate: TriggerCandidate }> = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const names = [entry.name, ...(entry.aliases ?? [])];
    if (spaced) {
      // As in omp, only the command whose name or alias is exactly the word before the space lists its subcommands.
      if (!names.some((name) => name.toLocaleLowerCase() === commandQuery)) continue;
      for (const subcommand of entry.subcommands ?? []) {
        const subScore = fuzzyScore(subcommand.name, subquery);
        if (subScore === null) continue;
        const candidate = subcommandCandidate(entry, subcommand, seen);
        if (candidate) ranked.push({ score: subScore, candidate });
      }
      continue;
    }
    const commandScore = bestScore(names, commandQuery);
    if (commandScore === null) continue;
    const candidate = commandCandidate(entry, seen);
    if (candidate) ranked.push({ score: commandScore, candidate });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.candidate.label.localeCompare(right.candidate.label);
  });
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
    const score = fuzzyScore(value, query);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

/** Exact, then prefix, then substring, then in-order letters. An empty query matches everything. */
function fuzzyScore(value: string, query: string): number | null {
  const normalizedValue = value.toLocaleLowerCase();
  if (query.length === 0) return 0;
  if (normalizedValue === query) return 1_000;
  if (normalizedValue.startsWith(query)) return 800 - normalizedValue.length;
  const index = normalizedValue.indexOf(query);
  if (index >= 0) return 600 - index - normalizedValue.length / 100;
  let queryIndex = 0;
  for (const char of normalizedValue) {
    if (char === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return 300 - normalizedValue.length / 100;
  }
  return null;
}
