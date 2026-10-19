import { MarkdownContent } from "../U1/markdown";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolCardState, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { splitToolResult } from "../U3/tool-card/result";
import { TextOutput } from "../U3/tool-card/text-output";
import { BrowserPreludeDetailsSchema, BrowserToolArgsSchema, safeRetrievalUrl } from "./models";

/** Render-only browser card; it never opens a browser or invokes a tool. */
export function BrowserToolCard(rendererProps: ToolRendererProps) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const argsResult = BrowserToolArgsSchema.safeParse(rendererProps.args);
  const args = argsResult.success ? argsResult.data : undefined;
  const result = rendererProps.result ?? normalized.result ?? normalized.partialResult;
  const split = splitToolResult(result);
  const detailsResult = BrowserPreludeDetailsSchema.safeParse(
    split.isEnvelope ? split.details : result,
  );
  const details = detailsResult.success ? detailsResult.data : undefined;
  const state: ToolCardState = {
    ...normalized,
    result: undefined,
    partialResult: undefined,
  };
  const rawResult = rawText(result);
  const returnedText = state.phase === "success" ? split.text : "";
  const action = args?.action ?? details?.action ?? "browser";
  const name = args?.name ?? details?.name;
  const url = args?.url ?? details?.url;
  const screenshots = details?.screenshots ?? [];
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
          {details?.value !== undefined && (
            <div
              className="bg-muted/30 max-h-56 overflow-auto rounded-lg p-3 text-xs"
              data-browser-value
              data-testid="t4-browser-value"
            >
              <p className="text-muted-foreground mb-2">Returned value</p>
              <pre className="whitespace-pre-wrap break-words">{compactValue(details.value)}</pre>
            </div>
          )}
          {screenshots.length > 0 && (
            <ul
              className="grid min-w-0 grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-2"
              data-browser-screenshots
              data-testid="t4-browser-screenshots"
            >
              {screenshots.slice(0, 4).map((screenshot, index) => (
                <li className="border-border max-w-60 rounded-lg border p-1" key={screenshot.dest}>
                  Screenshot {index + 1}: {screenshot.mimeType}, {screenshot.width} ×{" "}
                  {screenshot.height}, {screenshot.bytes} bytes
                </li>
              ))}
              {screenshots.length > 4 && (
                <li className="text-muted-foreground col-span-full text-xs">
                  Showing 4 of {screenshots.length} screenshots
                </li>
              )}
            </ul>
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

function compactValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "Value unavailable";
  }
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
