import { ExternalLinkIcon, InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ReadToolDetails } from "../T1/models";
import type { ReadUrlRendererProps } from "../T1/read-url-seam";
import { MarkdownContent } from "../U1/markdown";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolCardState } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { omittedOf } from "../U3/tool-card/output-meta";
import { TextOutput } from "../U3/tool-card/text-output";
import { safeRetrievalUrl } from "./models";

/** T4.2 implementation of T1's URL-read renderer seam; it never fetches in the browser. */
export function T4ReadUrlRenderer({
  rendererProps,
  details,
  rawResult,
  text,
}: ReadUrlRendererProps): ReactNode {
  const normalized = normalizeToolRendererProps(rendererProps);
  const state: ToolCardState = {
    ...normalized,
    result: undefined,
    partialResult: undefined,
  };
  // A real URL read carries its page in the text omp returned; `displayContent` is for line selections.
  const content = details.displayContent?.text;
  const returned = text.trim() === "" ? undefined : text;
  // A failed read says why in the banner; when the text is that same error, no text block repeats it.
  const errorIsText =
    returned !== undefined &&
    normalized.phase === "error" &&
    returned.trim() === normalized.error?.message;
  const shown = content ?? returned;
  const target = details.finalUrl ?? details.url ?? details.displayTarget ?? "URL read";
  const redirect = redirectLabel(details.url, details.finalUrl);
  const finalUrl = details.finalUrl ?? details.url;
  const title = titleFor(details, target);
  const lineCount =
    details.totalLines ?? (shown === undefined ? undefined : shown.split("\n").length);
  const characterCount = shown?.length;
  const sources = sourceItems(details);
  const catalog = catalogItems(details);
  const screenshots = screenshotItems(details);
  return (
    <div data-slot="t4-url-read" data-testid="t4-url-read">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        rawResult={rawResult}
        state={state}
        summary={title}
      />
      <section
        className="border-border/70 ms-2 flex min-w-0 flex-col gap-3 border-s-2 py-2 ps-4"
        data-slot="t4-url-read-body"
      >
        <header className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <span className="font-medium" data-url-title>
            {title}
          </span>
          <SafeLink href={finalUrl} label={urlLabel(finalUrl)} />
          {redirect && (
            <span className="text-muted-foreground text-xs" data-url-redirect>
              {redirect}
            </span>
          )}
        </header>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground" data-url-metadata>
          {details.contentType && (
            <span className="rounded border border-border px-2 py-0.5">{details.contentType}</span>
          )}
          {details.method && (
            <span className="rounded border border-border px-2 py-0.5">{details.method}</span>
          )}
          {lineCount !== undefined && (
            <span className="rounded border border-border px-2 py-0.5">
              {lineCount} {lineCount === 1 ? "line" : "lines"}
            </span>
          )}
          {characterCount !== undefined && (
            <span className="rounded border border-border px-2 py-0.5">
              {characterCount} {characterCount === 1 ? "char" : "chars"}
            </span>
          )}
        </div>
        {catalog.length > 0 && <CatalogMetadata items={catalog} />}
        {screenshots.length > 0 && <ScreenshotStrip screenshots={screenshots} />}
        {content !== undefined ? (
          <MarkdownPreview text={content} />
        ) : errorIsText ? null : returned !== undefined ? (
          <TextOutput text={returned} testId="t4-url-text" />
        ) : (
          <p className="border-border bg-muted/40 rounded-lg border p-3 text-sm text-muted-foreground">
            No page content was returned.
          </p>
        )}
        {details.notes && details.notes.length > 0 && (
          <p className="text-muted-foreground text-xs" data-url-notes>
            <span className="font-medium">Notes:</span> {details.notes.slice(0, 8).join(" · ")}
          </p>
        )}
        {sources.length > 0 && <SourceList sources={sources} />}
        {details.truncation && (
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            data-url-truncation
          >
            <InfoIcon aria-hidden="true" className="size-3.5" />
            <span>{truncationText(details.truncation)}</span>
          </div>
        )}
      </section>
    </div>
  );
}

function SafeLink({ href, label }: { readonly href: string | undefined; readonly label: string }) {
  const safe = safeRetrievalUrl(href);
  if (safe === undefined)
    return (
      <code className="text-muted-foreground max-w-full truncate" title={href}>
        {label}
      </code>
    );
  return (
    <a
      className="text-primary inline-flex max-w-full items-center gap-1 truncate underline underline-offset-2"
      href={safe}
      rel="noopener noreferrer"
      target="_blank"
    >
      <span className="truncate">{label}</span>
      <ExternalLinkIcon aria-hidden="true" className="size-3 shrink-0" />
    </a>
  );
}

function MarkdownPreview({ text }: { readonly text: string }) {
  return (
    <div className="min-w-0 overflow-hidden text-sm" data-url-markdown>
      <MarkdownContent text={text} variant="compact" />
    </div>
  );
}

type SourceItem = { readonly title: string; readonly url: string; readonly snippet?: string };

function SourceList({ sources }: { readonly sources: readonly SourceItem[] }) {
  return (
    <section className="border-border rounded-lg border p-3" data-url-sources>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">Sources</h3>
      <ul className="space-y-2">
        {sources.slice(0, 12).map((source) => (
          <li className="min-w-0" key={`${source.url}:${source.title}`}>
            <SafeLink href={source.url} label={source.title} />
            {source.snippet && (
              <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{source.snippet}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CatalogMetadata({ items }: { readonly items: readonly string[] }) {
  return (
    <div className="border-border bg-muted/30 rounded-lg border p-3 text-xs" data-url-catalog>
      <h3 className="mb-1 font-medium">Resource metadata</h3>
      <ul className="text-muted-foreground list-disc space-y-1 ps-4">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function ScreenshotStrip({ screenshots }: { readonly screenshots: readonly string[] }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-url-screenshots>
      {screenshots.map((src, index) => (
        <img
          alt={`Browser screenshot ${index + 1}`}
          className="border-border max-h-72 w-full rounded-lg border object-contain"
          key={src}
          src={src}
        />
      ))}
    </div>
  );
}

function titleFor(details: ReadToolDetails, target: string): string {
  const raw = details as Record<string, unknown>;
  if (typeof raw.title === "string" && raw.title.length > 0) return raw.title;
  const catalog = raw.catalog ?? raw.resource ?? raw.reference;
  if (catalog !== null && typeof catalog === "object" && !Array.isArray(catalog)) {
    const title = (catalog as Record<string, unknown>).title;
    if (typeof title === "string" && title.length > 0) return title;
  }
  try {
    return new URL(target).hostname || target;
  } catch {
    return target;
  }
}

function redirectLabel(
  original: string | undefined,
  final: string | undefined,
): string | undefined {
  if (original === undefined || final === undefined || original === final) return undefined;
  return `${urlLabel(original)} → ${urlLabel(final)}`;
}

function urlLabel(value: string | undefined): string {
  if (value === undefined) return "URL metadata";
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

function sourceItems(details: ReadToolDetails): readonly SourceItem[] {
  const raw = details as Record<string, unknown>;
  const candidates = Array.isArray(raw.sources)
    ? raw.sources
    : Array.isArray(raw.citations)
      ? raw.citations
      : [];
  return candidates.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const url = safeRetrievalUrl(record.url);
    if (url === undefined) return [];
    return [
      {
        title: typeof record.title === "string" ? record.title : url,
        url,
        ...(typeof record.snippet === "string" ? { snippet: record.snippet } : {}),
      },
    ];
  });
}

function catalogItems(details: ReadToolDetails): readonly string[] {
  const raw = details as Record<string, unknown>;
  if (typeof raw.url === "string") {
    try {
      const protocol = new URL(raw.url).protocol;
      if (protocol === "http:" || protocol === "https:") return [];
    } catch {
      return [];
    }
  }
  const source = raw.catalog ?? raw.resource ?? raw.reference;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return [];
  const record = source as Record<string, unknown>;
  return [
    typeof record.scheme === "string" ? `Scheme: ${record.scheme}` : undefined,
    typeof record.name === "string" ? `Name: ${record.name}` : undefined,
    typeof record.title === "string" ? `Title: ${record.title}` : undefined,
    typeof record.repository === "string" ? `Repository: ${record.repository}` : undefined,
    typeof record.number === "number" ? `#${record.number}` : undefined,
  ].filter((item): item is string => item !== undefined);
}

function screenshotItems(details: ReadToolDetails): readonly string[] {
  const raw = details as Record<string, unknown>;
  const candidates = Array.isArray(raw.screenshots) ? raw.screenshots : [];
  return candidates
    .flatMap((candidate) => {
      const value =
        typeof candidate === "string"
          ? candidate
          : candidate &&
              typeof candidate === "object" &&
              !Array.isArray(candidate) &&
              "data" in candidate &&
              typeof candidate.data === "string"
            ? candidate.data
            : undefined;
      return value?.startsWith("data:image/") ? [value.slice(0, 2_000_000)] : [];
    })
    .slice(0, 4);
}

function truncationText(meta: NonNullable<ReadToolDetails["truncation"]>): string {
  const left = omittedOf(meta);
  const omitted = [
    left.lines === undefined || left.lines === 0 ? undefined : `${left.lines} lines`,
    left.bytes === undefined || left.bytes === 0 ? undefined : `${left.bytes} bytes`,
  ].filter((item): item is string => item !== undefined);
  return omitted.length > 0
    ? `Output shortened; omitted ${omitted.join(" and ")}`
    : "Output shortened";
}
