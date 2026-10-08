import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type PortCallOptions,
  UrlCatalogPort,
  type UrlResource,
} from "@omp-app/contracts";
import type {
  MentionProvider,
  PromptExpansionResult,
  TextRange,
  TriggerCandidate,
  TriggerPosition,
  TriggerSearchResult,
} from "../contract";
import { isInsideCode } from "./emoji";
import type { LocalProvider } from "./provider";

export interface InternalUrlProviderOptions {
  readonly client: AppClient;
  readonly githubProvider?: MentionProvider;
  readonly limit?: number;
}

export interface InternalUrlTriggerMatch {
  readonly scheme: string;
  readonly query: string;
  readonly range: TextRange;
}

const OMP_SCHEMES = ["skill", "rule", "omp", "local", "memory", "agent", "artifact"] as const;
const BUILTIN_SCHEMES = ["issue", "pr"] as const;
const INTERNAL_URL_SCHEMES = [...OMP_SCHEMES, ...BUILTIN_SCHEMES] as const;
const INTERNAL_URL_SCHEME_SEPARATOR = "://";
const INTERNAL_URL_TRIGGER = "skill://";

type OmpScheme = (typeof OMP_SCHEMES)[number];
type BuiltinScheme = (typeof BUILTIN_SCHEMES)[number];

/**
 * A1.18's UrlScheme contract has only the seven omp schemes; issue:// and pr:// are omp's built-in
 * GitHub forms, whose numbered references come from the GitHub reference provider.
 * Research: `research/modules/D2.md:47-58`.
 */

function errorFrom(error: unknown): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    { code: "internal", message: "Internal URL search failed.", retryable: true },
    { cause: error },
  );
}

function isSchemeCharacter(character: string | undefined): boolean {
  return character !== undefined && /[a-z0-9+.-]/iu.test(character);
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s([{"'`>]/u.test(text[index - 1] ?? "");
}

export function detectInternalUrlTrigger(
  text: string,
  cursorPosition = text.length,
): InternalUrlTriggerMatch | null {
  const cursor = Math.max(0, Math.min(cursorPosition, text.length));
  if (isInsideCode(text, cursor)) return null;
  let start = cursor;
  while (start > 0 && !/[\s([{"'`>]/u.test(text[start - 1] ?? "")) start -= 1;
  const token = text.slice(start, cursor);
  const schemeEnd = token.indexOf(INTERNAL_URL_SCHEME_SEPARATOR);
  const scheme = token.slice(0, schemeEnd).toLocaleLowerCase();
  if (
    !/^[a-z][a-z0-9+.-]*$/u.test(scheme) ||
    !INTERNAL_URL_SCHEMES.includes(scheme as (typeof INTERNAL_URL_SCHEMES)[number])
  )
    return null;
  if (!isBoundary(text, start) || !isSchemeCharacter(scheme[0])) return null;
  return {
    scheme,
    query: token.slice(schemeEnd + INTERNAL_URL_SCHEME_SEPARATOR.length),
    range: { start, end: cursor },
  };
}

/** Splits the trigger slot's `scheme://rest` query. */
function splitUrlQuery(
  query: string,
): { readonly scheme: OmpScheme | BuiltinScheme; readonly rest: string } | null {
  const separator = query.indexOf(INTERNAL_URL_SCHEME_SEPARATOR);
  if (separator < 0) return null;
  const scheme = query.slice(0, separator).toLocaleLowerCase();
  const rest = query.slice(separator + INTERNAL_URL_SCHEME_SEPARATOR.length).trim();
  const known = INTERNAL_URL_SCHEMES.find((candidate) => candidate === scheme);
  return known === undefined ? null : { scheme: known, rest };
}

function isBuiltinScheme(scheme: OmpScheme | BuiltinScheme): scheme is BuiltinScheme {
  return scheme === "issue" || scheme === "pr";
}

/** Before a number is typed, issue:// and pr:// say what they take. */
function builtinHint(scheme: BuiltinScheme): TriggerCandidate {
  return {
    id: `url:${scheme}`,
    kind: "internal-url",
    source: "client",
    label: scheme === "issue" ? "Issue by number" : "Pull request by number",
    description: "Type the number from this repository",
    insertText: `${scheme}://`,
    metadata: { scheme, builtin: true },
  };
}

const RESOURCE_KIND_LABELS = {
  skill: "Skill",
  rule: "Rule",
  omp: "omp documentation",
  local: "Shared file",
  memory: "Memory",
  agent: "Agent output",
  artifact: "Artifact",
  app: "App",
} as const satisfies Record<UrlResource["kind"], string>;

function resourceCandidate(resource: UrlResource): TriggerCandidate {
  const kindLabel = RESOURCE_KIND_LABELS[resource.kind];
  return {
    id: `url:${resource.uri}`,
    kind: "internal-url",
    source: "a1.url-catalog",
    label: resource.label,
    description: `${kindLabel}${resource.description ? ` · ${resource.description}` : ""}`,
    insertText: `${resource.uri} `,
    metadata: { scheme: resource.scheme, uri: resource.uri, source: resource.source },
  };
}

export function createInternalUrlProvider(options: InternalUrlProviderOptions): LocalProvider {
  const port = options.client.port(UrlCatalogPort);
  const searchTyped = async (
    query: string,
    position?: TriggerPosition,
    callOptions?: PortCallOptions,
  ): Promise<TriggerSearchResult> => {
    const parsed = splitUrlQuery(query);
    if (parsed === null) return { state: "ready", candidates: [] };
    const withPosition = (candidates: readonly TriggerCandidate[]) =>
      candidates.map((candidate) => (position ? { ...candidate, position } : candidate));
    if (isBuiltinScheme(parsed.scheme)) {
      if (parsed.rest.length === 0) {
        return { state: "ready", candidates: withPosition([builtinHint(parsed.scheme)]) };
      }
      if (!/^[1-9]\d*$/u.test(parsed.rest)) return { state: "ready", candidates: [] };
      if (options.githubProvider) {
        return options.githubProvider.searchTyped(`${parsed.scheme} ${parsed.rest}`, position);
      }
      return {
        state: "unavailable",
        candidates: [],
        error: {
          state: "unavailable",
          error: {
            code: "unavailable",
            message: "Looking up issues and pull requests isn't available here.",
            retryable: false,
            capability: "host.github-refs",
          },
        },
      };
    }
    try {
      // The catalog matches `query` against each resource's value, label and description; the
      // scheme narrows the list to the one the user typed.
      const result = await port.list(
        { scheme: parsed.scheme, query: parsed.rest, limit: options.limit ?? 50 },
        callOptions,
      );
      return {
        state: "ready",
        candidates: withPosition(result.resources.map(resourceCandidate)),
        revision: result.revision,
      };
    } catch (error) {
      const failure = errorFrom(error);
      const state = failure.appError.code === "unavailable" ? "unavailable" : "error";
      return { state, candidates: [], error: { state, error: failure.appError } };
    }
  };
  return {
    trigger: INTERNAL_URL_TRIGGER,
    kind: "internal-url",
    source: "a1.url-catalog",
    search: async (query) => (await searchTyped(query)).candidates,
    searchTyped: (query, position) => searchTyped(query, position),
    // issue:// and pr:// are answered by GitHub only. Without a GitHub provider they offer nothing,
    // and that is known here, before any search runs, so no list opens for them.
    serves: (trigger) => {
      const scheme = trigger.slice(0, -INTERNAL_URL_SCHEME_SEPARATOR.length);
      const githubScheme = BUILTIN_SCHEMES.some((builtin) => builtin === scheme);
      return !githubScheme || options.githubProvider !== undefined;
    },
  };
}

export function expandInternalUrl(
  text: string,
  match: InternalUrlTriggerMatch,
  candidate: TriggerCandidate,
): PromptExpansionResult {
  if (isInsideCode(text, match.range.start)) {
    return {
      kind: "error",
      error: {
        code: "invalid_args",
        message: "Internal URL expansion is disabled inside code.",
        retryable: false,
      },
      replace: match.range,
      preserveText: true,
    };
  }
  const replacement = candidate.insertText ?? "";
  const range =
    replacement.endsWith(" ") && text[match.range.end] === " "
      ? { start: match.range.start, end: match.range.end + 1 }
      : match.range;
  const output = `${text.slice(0, range.start)}${replacement}${text.slice(range.end)}`;
  return {
    kind: "expanded",
    text: output,
    replace: range,
    cursor: range.start + replacement.length,
    attachmentRefs: [],
  };
}

export function internalUrlSchemes(): readonly string[] {
  return INTERNAL_URL_SCHEMES;
}
