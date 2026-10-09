import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type * as CodeLanguageModule from "../../markdown/code-language";
import { loadCodeLanguage } from "../../markdown/code-language";
import { CodeView } from "../../markdown/code-view";

// Every grammar chunk fails to load in this file, as a chunk that a network drop or a deploy would leave behind.
vi.mock("../../markdown/code-language", async (importOriginal) => {
  const actual = await importOriginal<typeof CodeLanguageModule>();
  return {
    ...actual,
    loadCodeLanguage: vi.fn(async () => {
      throw new Error("the grammar chunk did not load");
    }),
  };
});

afterEach(() => {
  cleanup();
});

describe("CodeView when a grammar chunk fails to load", () => {
  test("the code stays readable as plain text, under its language's name", async () => {
    const { container } = render(<CodeView code={"const a = 1;\nconst b = 2;"} language="ts" />);

    await waitFor(() => expect(loadCodeLanguage).toHaveBeenCalledTimes(1));
    // Let the failed load settle before looking at the block.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;

    expect(container.querySelector("[data-code-state]")?.getAttribute("data-code-state")).toBe(
      "plain",
    );
    expect(container.querySelector("[data-code-language]")?.textContent).toBe("typescript");
    expect(container.textContent).toContain("const b = 2;");
  });
});
