import { createRoot } from "react-dom/client";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { WebSearchCard } from "./web-search";

function props(
  toolCallId: string,
  result: unknown,
  query: string,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "web_search",
    args: { query },
    argsText: JSON.stringify({ query }),
    result,
    status,
  } as unknown as ToolRendererProps;
}

function WebSearchPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t4-web-search-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-5xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">T4.5 Web-search renderer</h1>
        <p className="text-muted-foreground text-sm">
          Markdown answers, retrieval sources and provider states
        </p>
      </header>
      <section className="mx-auto mt-6 flex w-full max-w-5xl flex-col gap-4">
        <WebSearchCard
          rendererProps={props(
            "search-success",
            {
              kind: "web_search",
              query: "omp app",
              response: {
                provider: "search-provider",
                model: "search-model",
                answer:
                  "# Omp app\n\nThe app uses [retrieval sources](https://example.com/docs) and **typed cards**.",
                sources: [
                  {
                    title: "Omp app documentation",
                    url: "https://example.com/docs",
                    domain: "example.com",
                    snippet: "A retrieval-provided source snippet.",
                    publishedDate: "2026-10-05",
                  },
                  {
                    title: "Project notes",
                    url: "https://example.org/notes",
                    domain: "example.org",
                    snippet: "Another source with bounded metadata.",
                    ageSeconds: 7200,
                  },
                ],
                citations: [
                  {
                    title: "Omp app documentation",
                    url: "https://example.com/docs",
                    citedText: "retrieval sources",
                  },
                ],
                relatedQuestions: ["How are tool cards composed?"],
                usage: { inputTokens: 42, outputTokens: 88, searchRequests: 2 },
                authMode: "managed",
              },
            },
            "omp app",
          )}
        />
        <WebSearchCard
          rendererProps={props(
            "search-empty",
            {
              kind: "web_search",
              query: "no sources",
              response: { provider: "search-provider", answer: "Nothing matched.", sources: [] },
            },
            "no sources",
          )}
        />
        <WebSearchCard
          rendererProps={props(
            "search-error",
            {
              kind: "web_search",
              query: "blocked provider",
              response: { provider: "search-provider", sources: [] },
              error: "Provider rejected the request",
            },
            "blocked provider",
          )}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t4-web-search-playground-root");
if (!root) throw new Error("T4.5 web-search playground root is missing.");
createRoot(root).render(<WebSearchPlayground />);
