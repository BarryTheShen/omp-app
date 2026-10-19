import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Icons } from "../../tokens";
import { MarkdownContent } from "../U1/markdown";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolCardPhase, ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { splitToolResult } from "../U3/tool-card/result";
import {
  type SearchCitation,
  type SearchRenderDetails,
  SearchRenderDetailsSchema,
  type SearchResponse,
  type SearchSource,
  safeRetrievalUrl,
  searchAuthLabel,
  searchProviderLabel,
} from "./models";

const MAX_SOURCES = 32;
const MAX_CITATIONS = 32;
const MAX_RELATED_QUESTIONS = 8;
const MAX_ANSWER_CHARS = 40_000;

type CopyHandler = (raw: string, kind: "code") => void | Promise<void>;

export interface WebSearchCardProps {
  readonly rendererProps: ToolRendererProps;
  readonly onCopy?: CopyHandler;
}

/** Renders a retrieval-only web search result; it never performs search or link navigation itself. */
export function WebSearchCard({ rendererProps, onCopy }: WebSearchCardProps) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const query = queryFromArgs(rendererProps.args);
  // omp's result is `{ content, details }`: the search is in `details.response`, its answer text is
  // the fallback. While the call streams, R0's projection is shaped like the details.
  const resultSource = rendererProps.result ?? normalized.result ?? normalized.partialResult;
  const split = splitToolResult(resultSource);
  const detailSource = split.isEnvelope
    ? split.details
    : (normalized.streamProjection ?? resultSource);
  const rawResult = rawText(resultSource ?? normalized.streamProjection);
  const fallbackText = split.text !== "" ? split.text : rawResult;
  const parsed =
    detailSource === undefined ? undefined : SearchRenderDetailsSchema.safeParse(detailSource);
  const details = parsed?.success === true ? parsed.data : undefined;
  const summary = middleEllipsis(details?.query ?? query ?? "web search");
  const failed = details?.error !== undefined;
  const state = {
    ...normalized,
    ...(failed && normalized.phase === "success"
      ? {
          phase: "error" as const,
          isError: true,
          error: {
            code: "omp_error" as const,
            message: details.error ?? "Provider error",
            retryable: false,
          },
        }
      : {}),
    result: undefined,
    partialResult: undefined,
  };

  // A failed call is its error banner (omp's own words say why); a body would only be empty.
  if (normalized.phase === "error" && details === undefined) {
    return (
      <div data-slot="t4-web-search-card" data-testid="t4-web-search-card">
        <ToolCard
          className="[&_[data-slot='u3-tool-card-args']]:hidden"
          rawResult={rawResult}
          state={state}
          summary={summary}
        />
      </div>
    );
  }
  if (parsed !== undefined && !parsed.success && isSettled(normalized.phase)) {
    return (
      <div data-slot="t4-web-search-card" data-testid="t4-web-search-card">
        <ToolCard
          className="[&_[data-slot='u3-tool-card-args']]:hidden"
          rawResult={rawResult}
          state={{
            ...state,
            phase: "error",
            isError: true,
            error: {
              code: "invalid_args",
              message: "Malformed web-search result; showing the recorded result.",
              retryable: false,
            },
          }}
          summary="Web-search result unavailable"
        />
      </div>
    );
  }

  return (
    <div data-slot="t4-web-search-card" data-testid="t4-web-search-card">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        rawResult=""
        state={state}
        summary={summary}
      >
        {!(details?.error !== undefined && state.phase === "error") && (
          <SearchBody
            details={details}
            fallbackText={details === undefined ? fallbackText : undefined}
            onCopy={onCopy}
            phase={state.phase}
            query={details?.query ?? query}
          />
        )}
      </ToolCard>
    </div>
  );
}

/** Descriptor renderer entry for the T4.web-search descriptor. */
export const WebSearchToolRenderer: ToolRenderer = (props) => (
  <WebSearchCard rendererProps={props} />
);

function SearchBody({
  details,
  fallbackText,
  onCopy,
  phase,
  query,
}: {
  readonly details?: SearchRenderDetails;
  readonly fallbackText?: string;
  readonly onCopy?: CopyHandler;
  readonly phase: ToolCardPhase;
  readonly query?: string;
}) {
  const response = details?.response;
  const answer = response?.answer?.slice(0, MAX_ANSWER_CHARS);
  const sourceCount = response?.sources.length ?? 0;
  const provider = searchProviderLabel(response?.provider);
  const copyText = answer ?? fallbackText ?? "";
  return (
    <section className="flex min-w-0 flex-col gap-3 py-2" data-slot="t4-web-search-body">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono" title={query ?? "web search"}>
          {middleEllipsis(query ?? "web search")}
        </span>
        {provider && <span className="rounded bg-muted px-2 py-0.5">{provider}</span>}
        {response && (
          <span>
            {sourceCount} result{sourceCount === 1 ? "" : "s"}
          </span>
        )}
        {response?.model && <span>Model: {response.model}</span>}
      </div>
      {details?.error && phase !== "error" ? (
        <div
          className="bg-danger-surface text-danger-surface-foreground rounded-lg p-3 text-sm"
          data-slot="t4-web-search-provider-error"
          role="alert"
        >
          {details.error}
        </div>
      ) : response !== undefined ? (
        <>
          {answer ? <MarkdownAnswer text={answer} /> : <EmptyAnswer phase={phase} />}
          <SourceTree citations={response.citations} sources={response.sources} />
          {response.relatedQuestions && response.relatedQuestions.length > 0 && (
            <RelatedQuestions questions={response.relatedQuestions} />
          )}
          <UsageMetadata response={response} />
          <CopyButton onCopy={onCopy} raw={copyText} />
        </>
      ) : fallbackText ? (
        <RawSearchPreview text={fallbackText} />
      ) : (
        <EmptyAnswer phase={phase} />
      )}
    </section>
  );
}

function MarkdownAnswer({ text }: { readonly text: string }) {
  return (
    <div className="min-w-0" data-slot="t4-web-search-answer">
      <MarkdownContent text={text} variant="compact" />
    </div>
  );
}

function SourceTree({
  citations,
  sources,
}: {
  readonly citations?: readonly SearchCitation[];
  readonly sources: readonly SearchSource[];
}) {
  const visibleSources = sources.slice(0, MAX_SOURCES);
  const visibleCitations = (citations ?? []).slice(0, MAX_CITATIONS);
  return (
    <section className="flex flex-col gap-2" data-slot="t4-web-search-sources">
      <h3 className="text-sm font-medium text-foreground">Sources</h3>
      {visibleSources.length === 0 ? (
        <p className="text-warning text-sm">No sources were returned for this search.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {visibleSources.map((source, index) => (
            <li
              className="flex min-w-0 gap-2 rounded-lg bg-muted/30 p-2"
              key={sourceKey(source, index)}
            >
              <span className="text-xs font-medium text-muted-foreground">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <SourceLink source={source} />
                <p className="text-muted-foreground text-xs">
                  {[source.domain ?? sourceHost(source), sourceAge(source)]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {source.snippet && (
                  <p className="mt-1 text-sm text-muted-foreground">{source.snippet}</p>
                )}
                {source.author && (
                  <p className="mt-1 text-xs text-muted-foreground">By {source.author}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {visibleCitations.length > 0 && (
        <div className="flex flex-col gap-1" data-slot="t4-web-search-citations">
          <h4 className="text-xs font-medium text-muted-foreground">Citations</h4>
          <ol className="flex flex-col gap-1">
            {visibleCitations.map((citation, index) => (
              <li className="text-sm" key={citationKey(citation, index)}>
                <span className="me-1 text-xs font-medium text-muted-foreground">
                  [{index + 1}]
                </span>
                <CitationLink citation={citation} />
                {citation.citedText && (
                  <span className="text-muted-foreground"> — {citation.citedText}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {sources.length > visibleSources.length && (
        <p className="text-xs text-muted-foreground">
          Showing {visibleSources.length} of {sources.length} sources.
        </p>
      )}
      {(citations ?? []).length > visibleCitations.length && (
        <p className="text-xs text-muted-foreground">
          Showing {visibleCitations.length} of {(citations ?? []).length} citations.
        </p>
      )}
    </section>
  );
}

function SourceLink({ source }: { readonly source: SearchSource }) {
  const safe = safeRetrievalUrl(source.url);
  const label =
    source.title?.trim() || source.domain?.trim() || sourceHost(source) || "Untitled source";
  if (safe === undefined) return <span className="font-medium text-foreground">{label}</span>;
  return (
    <a
      className="font-medium text-primary underline underline-offset-2"
      href={safe}
      rel="noopener noreferrer"
      target="_blank"
    >
      {label}
    </a>
  );
}

function CitationLink({ citation }: { readonly citation: SearchCitation }) {
  const safe = safeRetrievalUrl(citation.url);
  const label = citation.title ?? (safe ? sourceHost({ url: safe }) : undefined) ?? "Source";
  if (safe === undefined) return <span>{label}</span>;
  return (
    <a
      className="text-primary underline underline-offset-2"
      href={safe}
      rel="noopener noreferrer"
      target="_blank"
    >
      {label}
    </a>
  );
}

function RelatedQuestions({ questions }: { readonly questions: readonly string[] }) {
  const visible = questions.slice(0, MAX_RELATED_QUESTIONS);
  return (
    <section className="flex flex-col gap-1" data-slot="t4-web-search-related">
      <h3 className="text-xs font-medium text-muted-foreground">Related questions</h3>
      <ul className="list-disc ps-5 text-sm text-muted-foreground">
        {visible.map((question) => (
          <li key={question}>{question}</li>
        ))}
      </ul>
      {questions.length > visible.length && (
        <p className="text-xs text-muted-foreground">
          Showing {visible.length} of {questions.length} questions.
        </p>
      )}
    </section>
  );
}

function UsageMetadata({ response }: { readonly response: SearchResponse }) {
  const usage = response.usage;
  const metadata: string[] = [
    response.provider ? `Provider: ${searchProviderLabel(response.provider)}` : undefined,
    `${response.sources.length} result${response.sources.length === 1 ? "" : "s"}`,
    usage?.searchRequests !== undefined ? `Search requests: ${usage.searchRequests}` : undefined,
    usage?.inputTokens !== undefined ? `Input tokens: ${usage.inputTokens}` : undefined,
    usage?.outputTokens !== undefined ? `Output tokens: ${usage.outputTokens}` : undefined,
    usage?.totalTokens !== undefined ? `Total tokens: ${usage.totalTokens}` : undefined,
    response.authMode ? `Auth: ${searchAuthLabel(response.authMode)}` : undefined,
  ].filter((item): item is string => item !== undefined);
  return (
    <div
      className="flex flex-wrap gap-2 text-xs text-muted-foreground"
      data-slot="t4-web-search-usage"
    >
      {metadata.map((item) => (
        <span className="rounded bg-muted px-2 py-0.5" key={item}>
          {item}
        </span>
      ))}
    </div>
  );
}

function CopyButton({ onCopy, raw }: { readonly onCopy?: CopyHandler; readonly raw: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      if (onCopy !== undefined) await onCopy(raw, "code");
      else if (typeof navigator !== "undefined" && navigator.clipboard !== undefined)
        await navigator.clipboard.writeText(raw);
      else throw new Error("Clipboard unavailable");
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Button
        aria-label="Copy answer"
        disabled={raw.length === 0}
        size="xs"
        type="button"
        variant="outline"
        onClick={() => void copy()}
      >
        <Icons.copy aria-hidden="true" />
        Copy answer
      </Button>
      {status !== "idle" && (
        <span aria-live="polite" className="text-xs text-muted-foreground" role="status">
          {status === "copied" ? "Copied answer" : "Copy unavailable"}
        </span>
      )}
    </div>
  );
}

function RawSearchPreview({ text }: { readonly text: string }) {
  const bounded = text.length > MAX_ANSWER_CHARS ? `${text.slice(0, MAX_ANSWER_CHARS)}…` : text;
  return (
    <pre
      className="bg-muted/40 max-h-80 overflow-auto rounded-lg p-3 text-xs leading-relaxed whitespace-pre-wrap break-words"
      data-slot="t4-web-search-raw-preview"
    >
      {bounded}
    </pre>
  );
}

function EmptyAnswer({ phase }: { readonly phase: ToolCardPhase }) {
  return (
    <p className="bg-muted/40 rounded-lg p-3 text-sm text-muted-foreground">
      {phase === "running" || phase === "partial"
        ? "Waiting for search results…"
        : "No answer was returned."}
    </p>
  );
}

function queryFromArgs(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>).query;
  return typeof value === "string" ? value : undefined;
}

function sourceHost(source: Pick<SearchSource, "url" | "domain">): string | undefined {
  if (source.domain) return source.domain;
  const safe = safeRetrievalUrl(source.url);
  if (safe === undefined) return undefined;
  try {
    return new URL(safe).host;
  } catch {
    return undefined;
  }
}

function sourceAge(source: SearchSource): string | undefined {
  if (source.publishedDate) return source.publishedDate;
  if (source.ageSeconds === undefined) return undefined;
  if (source.ageSeconds < 60) return "Just now";
  if (source.ageSeconds < 3_600) return `${Math.floor(source.ageSeconds / 60)}m ago`;
  if (source.ageSeconds < 86_400) return `${Math.floor(source.ageSeconds / 3_600)}h ago`;
  return `${Math.floor(source.ageSeconds / 86_400)}d ago`;
}

function sourceKey(source: SearchSource, index: number): string {
  return `${source.url ?? source.title ?? "source"}-${index}`;
}

function citationKey(citation: SearchCitation, index: number): string {
  return `${citation.url ?? citation.title ?? "citation"}-${index}`;
}

function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[Unserializable web-search result]";
  }
}

function isSettled(phase: ToolCardPhase): boolean {
  return phase === "success" || phase === "error";
}

function middleEllipsis(value: string, max = 120): string {
  if (value.length <= max) return value;
  const side = Math.floor((max - 1) / 2);
  return `${value.slice(0, side)}…${value.slice(-side)}`;
}
