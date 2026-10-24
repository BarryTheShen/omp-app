import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { FindCard } from "./find";

function props(
  toolCallId: string,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
  query = "retry budget",
): ToolRendererProps {
  const args = { query, grep_keywords: query.split(" "), path: "src" };
  return {
    type: "tool-call",
    toolCallId,
    toolName: "find",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

function FindPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t2-find-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-4xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">Semantic find card</h1>
        <p className="text-muted-foreground text-sm">
          Scored hits, verified line ranges, cut lists and search accounting
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-4xl flex-col gap-5 rounded-xl border p-4 shadow-xs sm:p-6">
        <FindCard
          rendererProps={props("find-hits", {
            content: [{ type: "text", text: "2 hits" }],
            details: {
              query: "retry budget",
              keywords: ["retry", "budget"],
              threshold: 0.2,
              cwd: "/repo",
              elapsedMs: 1500,
              hits: [
                {
                  rel: "src/net/retry.ts",
                  nameScore: 0.8,
                  contentScore: 0.9,
                  linesSeen: 120,
                  truncated: false,
                  ranges: [
                    { start: 10, end: 20, p: 0.9, snippet: "export function retryBudget(limit) {" },
                    { start: 64, end: 71, p: 0.62, snippet: "if (budget.spent >= limit) return;" },
                  ],
                },
                {
                  rel: "src/config/defaults.ts",
                  nameScore: 0.3,
                  contentScore: 0.7,
                  linesSeen: 48,
                  truncated: false,
                  ranges: [{ start: 5, end: 5, p: 0.71, snippet: "retryBudget: 3," }],
                },
              ],
              coverage: "partial",
              stats: {
                listed: 2,
                requests: 3,
                failed: 1,
                unanswered: 0,
                judged: 2,
                filesRead: 2,
                fileBytes: 100,
                inputTokens: 1200,
                outputTokens: 0,
                cost: 0,
                apiMs: 900,
                windowsJudged: 4,
                windowsPruned: 1,
                mapCards: 3,
                failures: ["verification: request timed out"],
              },
            },
          })}
        />
        <FindCard
          rendererProps={props(
            "find-cut",
            {
              content: [{ type: "text", text: "34 hits" }],
              details: {
                query: "logger setup",
                elapsedMs: 4200,
                hits: Array.from({ length: 34 }, (_, index) => ({
                  rel: `src/services/service-${index + 1}.ts`,
                  ranges: [
                    {
                      start: 3,
                      end: 9,
                      p: Math.max(0.2, 0.95 - index * 0.02),
                      snippet: "const logger = createLogger({ level: 'info' });",
                    },
                  ],
                })),
                stats: { requests: 12, inputTokens: 18450, failures: [] },
              },
            },
            { type: "complete" },
            "logger setup",
          )}
        />
        <FindCard
          rendererProps={props(
            "find-empty",
            {
              content: [{ type: "text", text: "No hits" }],
              details: { query: "billing webhook", hits: [], stats: { requests: 1, apiMs: 400 } },
            },
            { type: "complete" },
            "billing webhook",
          )}
        />
        <FindCard rendererProps={props("find-running", undefined, { type: "running" })} />
      </section>
    </main>
  );
}

const root = document.getElementById("t2-find-playground-root");
if (!root) throw new Error("The semantic find playground root is missing.");
createRoot(root).render(<FindPlayground />);
