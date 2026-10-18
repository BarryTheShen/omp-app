import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../../components/ui/dialog";
import { MarkdownContent } from "../U1/markdown";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolCardState, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { splitToolResult } from "../U3/tool-card/result";
import { TextOutput } from "../U3/tool-card/text-output";
import {
  type BrowserPreludeDetails,
  BrowserPreludeDetailsSchema,
  BrowserToolArgsSchema,
  safeRetrievalUrl,
} from "./models";

/** Render-only browser card; it never opens a browser or invokes a tool. */
export function BrowserToolCard(rendererProps: ToolRendererProps) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const argsResult = BrowserToolArgsSchema.safeParse(rendererProps.args);
  const args = argsResult.success ? argsResult.data : undefined;
  const detailsResult = BrowserPreludeDetailsSchema.safeParse(
    rendererProps.result ?? normalized.result ?? normalized.partialResult,
  );
  const details = detailsResult.success ? detailsResult.data : undefined;
  const state: ToolCardState = {
    ...normalized,
    ...(details?.error === undefined
      ? {}
      : {
          phase: "error" as const,
          isError: true,
          error: { message: details.error, retryable: false },
        }),
    result: undefined,
    partialResult: undefined,
  };
  const rawResult = rawText(rendererProps.result ?? normalized.result ?? normalized.partialResult);
  // The answer a call returned (a script's value, a close report) is what the person came for: show its text.
  const returnedText =
    state.phase === "success"
      ? splitToolResult(rendererProps.result ?? normalized.result).text
      : "";
  const action = args?.action ?? details?.action ?? "browser";
  const name = args?.name ?? details?.name;
  const url = args?.url ?? details?.url;
  const observations = details?.observations ?? [];
  const screenshots = screenshotItems(details);
  return (
    <div data-slot="t4-browser-card" data-testid="t4-browser-card">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        rawResult={rawResult}
        state={state}
        summary={browserSummary(action, name, url)}
      >
        <section className="flex min-w-0 flex-col gap-3 py-2" data-browser-content>
          {url && url.length > 64 && safeRetrievalUrl(url) && (
            <a
              className="text-primary truncate text-xs underline underline-offset-2"
              href={safeRetrievalUrl(url)}
              rel="noopener noreferrer"
              target="_blank"
            >
              Full URL
            </a>
          )}
          {args?.code || args?.fn ? <JavascriptCell code={args.code ?? args.fn ?? ""} /> : null}
          {returnedText !== "" && <TextOutput testId="t4-browser-returned" text={returnedText} />}
          {observations.length > 0 && (
            <div
              className="bg-muted/30 max-h-56 overflow-auto rounded-lg p-3 text-xs"
              data-browser-observations
              data-testid="t4-browser-observations"
            >
              <p className="text-muted-foreground mb-2">
                {observations.length === 1
                  ? "1 observation"
                  : `${observations.length} observations`}
              </p>
              {observations.slice(0, 12).map((observation) => (
                <ObservationRow key={observationKey(observation)} value={observation} />
              ))}
              {observations.length > 12 && (
                <p className="text-muted-foreground mt-2">Showing 12 of {observations.length}</p>
              )}
            </div>
          )}
          {screenshots.length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-browser-screenshots>
              <p className="text-muted-foreground col-span-full text-xs">
                {screenshots.length === 1 ? "1 screenshot" : `${screenshots.length} screenshots`}
              </p>
              {screenshots.slice(0, 4).map((source, index) => (
                <Dialog key={source}>
                  <DialogTrigger
                    render={
                      <button
                        aria-label={`Open browser screenshot ${index + 1}`}
                        type="button"
                        className="border-border max-w-60 cursor-zoom-in rounded-lg border p-1 focus-visible:ring-3 focus-visible:ring-ring/50"
                      />
                    }
                  >
                    <img
                      alt={`Browser screenshot ${index + 1}`}
                      className="max-h-72 w-full object-contain"
                      src={source}
                    />
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-5xl">
                    <DialogTitle>Browser screenshot {index + 1}</DialogTitle>
                    <img
                      alt={`Browser screenshot ${index + 1}`}
                      className="max-h-[80dvh] w-full object-contain"
                      src={source}
                    />
                  </DialogContent>
                </Dialog>
              ))}
            </div>
          )}
        </section>
      </ToolCard>
    </div>
  );
}

function JavascriptCell({ code }: { readonly code: string }) {
  return (
    <div className="min-w-0" data-browser-code>
      <MarkdownContent text={`\`\`\`javascript\n${code}\n\`\`\``} variant="compact" />
    </div>
  );
}

function actionLabel(action: string): string {
  return action.replace(/_/g, " ").replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function browserSummary(action: string, name: string | undefined, url: string | undefined): string {
  return [actionLabel(action), name, url].filter(Boolean).join(" · ");
}

function ObservationRow({ value }: { readonly value: unknown }) {
  if (typeof value === "string") {
    return <p className="whitespace-pre-wrap break-words">{value}</p>;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return (
      <dl className="space-y-1">
        {Object.entries(value as Record<string, unknown>)
          .slice(0, 12)
          .map(([key, nested]) => (
            <div className="flex min-w-0 gap-3" key={key}>
              <dt className="shrink-0 font-medium text-muted-foreground">{key}</dt>
              <dd className="min-w-0">
                <code className="font-mono text-info break-words">{compactValue(nested)}</code>
              </dd>
            </div>
          ))}
      </dl>
    );
  }
  return <code className="font-mono text-info break-words">{compactValue(value)}</code>;
}

function observationKey(value: unknown): string {
  return compactValue(value);
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "Value unavailable";
  }
}

function screenshotItems(details: BrowserPreludeDetails | undefined): readonly string[] {
  const candidates = details?.screenshots ?? [];
  return candidates
    .flatMap((candidate) => {
      const source = typeof candidate.data === "string" ? candidate.data : undefined;
      return source?.startsWith("data:image/") ? [source.slice(0, 2_000_000)] : [];
    })
    .slice(0, 4);
}

function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
