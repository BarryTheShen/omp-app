import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { WebSearchCard } from "./web-search";

afterEach(cleanup);

describe("web_search details as omp v18.12.6 builds them", () => {
  // `packages/tui/src/tools/web-search-types.ts:12-37`: v18.12.6 added the `deepseek` provider (:29, "DeepSeek"),
  // `packages/coding-agent/src/web/search/provider.ts:28`. The response shape is the one of v18.9.1.
  test("names a DeepSeek search 'DeepSeek', not the generic 'Web search'", () => {
    const args = { query: "bun release notes" };
    const result = {
      content: [{ type: "text", text: "Bun 1.3 ships a faster installer." }],
      details: {
        response: {
          provider: "deepseek",
          answer: "Bun 1.3 ships a faster installer.",
          sources: [{ title: "Bun 1.3", url: "https://bun.sh/blog/bun-v1.3" }],
        },
      },
    };
    render(
      <WebSearchCard
        rendererProps={
          {
            type: "tool-call",
            toolCallId: "web-search-deepseek",
            toolName: "web_search",
            args,
            argsText: JSON.stringify(args),
            result,
            status: { type: "complete" },
          } as unknown as ToolRendererProps
        }
      />,
    );
    expandToolCards();

    expect(screen.getByText("Provider: DeepSeek")).toBeTruthy();
    expect(screen.queryByText("Provider: Web search")).toBeNull();
  });
});
