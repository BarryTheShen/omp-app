import { createRoot } from "react-dom/client";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { T4ReadUrlRenderer } from "./url-read";

const details = {
  kind: "url" as const,
  url: "https://example.test/docs",
  finalUrl: "https://example.test/docs/final",
  contentType: "text/markdown",
  method: "GET",
  title: "Retrieved documentation",
  displayContent: {
    text: "# Retrieved documentation\n\nThe page is **untrusted content**. See [the source](https://source.test/docs) for the cited page.\n\n- preserved Markdown\n- safe links",
  },
  notes: ["Redirected by the retrieval service", "Content is untrusted text"],
  truncation: { direction: "tail" as const, reason: "lines" as const, omittedLines: 12 },
  sources: [
    { title: "Source page", url: "https://source.test/docs", snippet: "Retrieved source snippet" },
  ],
  catalog: { scheme: "https", title: "Retrieved documentation" },
};

const rendererProps = {
  type: "tool-call",
  toolCallId: "t4-url-playground",
  toolName: "read",
  args: { path: details.url },
  argsText: JSON.stringify({ path: details.url }),
  result: details,
  status: { type: "complete" },
} as unknown as ToolRendererProps;

export function T4UrlReadPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t4-url-playground"
    >
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <header>
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-widest">
            T4.2 URL read
          </p>
          <h1 className="mt-2 text-2xl font-semibold">Retrieved page</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Redirects, untrusted Markdown, source links and truncation metadata.
          </p>
        </header>
        <T4ReadUrlRenderer
          toolCallId={"t4-url-playground" as never}
          rendererProps={rendererProps}
          details={details as never}
          rawArgs={JSON.stringify({ path: details.url })}
          rawResult={JSON.stringify(details)}
        />
      </div>
    </main>
  );
}

const root = document.getElementById("t4-url-read-playground-root");
if (root) createRoot(root).render(<T4UrlReadPlayground />);
