import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CODE_HIGHLIGHT_LIMIT, CodeView, codeLines } from "../../markdown/code-view";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const SAMPLE = "const answer: number = 42; // the answer";

function stateOf(container: HTMLElement): string | null {
  return container.querySelector("[data-code-state]")?.getAttribute("data-code-state") ?? null;
}

/** How many coloured tokens line `index` of the block has. */
function colouredTokensOn(container: HTMLElement, index: number): number {
  const row = Array.from(container.querySelectorAll("pre code > span.block")).at(index);
  return row?.querySelectorAll("[data-code-token]").length ?? 0;
}

/** How many tokens of line `index` carry a token-sheet colour (a plain token only carries the code foreground). */
function themedTokensOn(container: HTMLElement, index: number): number {
  const row = Array.from(container.querySelectorAll("pre code > span.block")).at(index);
  const tokens = Array.from(row?.querySelectorAll<HTMLElement>("[data-code-token]") ?? []);
  return tokens.filter((token) => (token.getAttribute("style") ?? "").includes("--code-token-"))
    .length;
}

describe("CodeView", () => {
  test("shows the text as plain text for a language it does not know, and labels it", () => {
    const { container } = render(<CodeView code="just words" language="nonsense" />);

    expect(stateOf(container)).toBe("plain");
    expect(container.querySelector("[data-code-language]")?.textContent).toBe("nonsense");
    expect(container.querySelectorAll("[data-code-token]")).toHaveLength(0);
    expect(container.textContent).toContain("just words");
  });

  test("labels a block with no language as text", () => {
    const { container } = render(<CodeView code="plain" />);

    expect(container.querySelector("[data-code-language]")?.textContent).toBe("text");
  });

  test("labels a block with its language's name, as the cards do", () => {
    const { container } = render(<CodeView code="const a = 1;" language="ts" />);

    expect(container.querySelector("[data-code-language]")?.textContent).toBe("typescript");
  });

  test("colours a TypeScript sample with the token sheet's variables", async () => {
    const { container } = render(<CodeView code={SAMPLE} language="ts" />);

    await waitFor(() => expect(stateOf(container)).toBe("highlighted"));
    const tokens = [...container.querySelectorAll<HTMLElement>("[data-code-token]")];
    // Every character of the sample is in a token, and the tokens take several colours.
    expect(tokens.map((token) => token.textContent).join("")).toBe(SAMPLE);
    for (const token of tokens) {
      expect(token.getAttribute("style") ?? "").toContain("var(--code-");
    }
    // Keywords, names, punctuation and comments take different colours; a partly tokenized run has fewer.
    expect(new Set(tokens.map((token) => token.getAttribute("style"))).size).toBeGreaterThanOrEqual(
      3,
    );
  });

  test("a short block that changes is coloured in the frame that shows it", async () => {
    const { container, rerender } = render(<CodeView code={SAMPLE} language="ts" />);
    await waitFor(() => expect(stateOf(container)).toBe("highlighted"));

    rerender(<CodeView code="const other = 1;" language="ts" />);

    expect(stateOf(container)).toBe("highlighted");
    expect(colouredTokensOn(container, 0)).toBeGreaterThan(0);
  });

  test("a longer block that grows colours the new line in its own frame, and keeps the unchanged lines", async () => {
    // About 4.5 KB: over the short-block limit, so the first colours come from the background.
    const lines = Array.from({ length: 200 }, (_, index) => `const value${index} = ${index};`);
    const { container, rerender } = render(<CodeView code={lines.join("\n")} language="ts" />);
    await waitFor(() => expect(stateOf(container)).toBe("highlighted"));

    rerender(<CodeView code={[...lines, "const last = 1;"].join("\n")} language="ts" />);

    // A change this small is tokenized in the render that shows it: the new line is coloured in that frame.
    expect(stateOf(container)).toBe("highlighted");
    expect(colouredTokensOn(container, 0)).toBeGreaterThan(0);
    expect(colouredTokensOn(container, 199)).toBeGreaterThan(0);
    expect(colouredTokensOn(container, 200)).toBeGreaterThan(0);
  });

  test("a block that grows past the short-block limit is never plain once it is coloured", async () => {
    const line = (index: number) => `const value${index} = ${index}; // ${"x".repeat(40)}`;
    // 32 lines end just under the limit; the next four carry the block past it, one line at a time.
    const lines = Array.from({ length: 36 }, (_, index) => line(index));
    expect(lines.slice(0, 32).join("\n").length).toBeLessThanOrEqual(2_048);
    expect(lines.join("\n").length).toBeGreaterThan(2_048);
    const { container, rerender } = render(
      <CodeView code={lines.slice(0, 32).join("\n")} language="ts" />,
    );
    await waitFor(() => expect(stateOf(container)).toBe("highlighted"));

    const states: (string | null)[] = [];
    for (let count = 33; count <= lines.length; count += 1) {
      rerender(<CodeView code={lines.slice(0, count).join("\n")} language="ts" />);
      states.push(stateOf(container));
    }

    expect(states).not.toContain("plain");
    expect(colouredTokensOn(container, lines.length - 1)).toBeGreaterThan(0);
  });

  test("a block mounted again past the short-block limit is coloured from its first render", async () => {
    const code = Array.from(
      { length: 120 },
      (_, index) => `const remounted${index} = ${index};`,
    ).join("\n");
    expect(code.length).toBeGreaterThan(2_048);
    const first = render(<CodeView code={code} language="ts" />);
    await waitFor(() => expect(stateOf(first.container)).toBe("highlighted"));
    first.unmount();

    const again = render(<CodeView code={code} language="ts" />);

    expect(stateOf(again.container)).toBe("highlighted");
    expect(colouredTokensOn(again.container, 0)).toBeGreaterThan(0);
  });

  test("a line of 500 characters or more stays plain, and the lines around it are coloured", async () => {
    const longLine = `const filler = [${"0, ".repeat(300)}];`;
    const { container } = render(<CodeView code={`${longLine}\nconst short = 1;`} language="ts" />);

    await waitFor(() => expect(themedTokensOn(container, 1)).toBeGreaterThan(0));
    expect(themedTokensOn(container, 0)).toBe(0);
  });

  test("a block mounted again with the same code shows its colours from the first render", async () => {
    const code = "const remounted = 'again';";
    const first = render(<CodeView code={code} language="ts" />);
    await waitFor(() => expect(stateOf(first.container)).toBe("highlighted"));
    first.unmount();

    const again = render(<CodeView code={code} language="ts" />);

    expect(stateOf(again.container)).toBe("highlighted");
    expect(colouredTokensOn(again.container, 0)).toBeGreaterThan(0);
  });

  test("code past the size bound is never highlighted", async () => {
    const { container } = render(
      <CodeView code={"x".repeat(CODE_HIGHLIGHT_LIMIT + 1)} language="ts" />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(stateOf(container)).toBe("plain");
    expect(container.querySelectorAll("[data-code-token]")).toHaveLength(0);
  });

  test("numbers each line from the numbers it is given, and leaves a null line unnumbered", () => {
    const { container } = render(<CodeView code={"one\ntwo\nthree"} lineNumbers={[4, null, 6]} />);

    const gutter = [...container.querySelectorAll("code [aria-hidden='true']")].map(
      (number) => number.textContent,
    );
    expect(gutter).toEqual(["4", "", "6"]);
  });

  test("a Windows or old Mac line ending makes the same lines as a Unix one", () => {
    expect(codeLines("a\r\nb\rc")).toEqual(["a", "b", "c"]);
    const { container } = render(<CodeView code={"a\r\nb\r\n"} />);

    expect(container.querySelectorAll("pre code > span.block")).toHaveLength(3);
  });

  test("copies through the owner's copy, names the button, and announces Copied", async () => {
    const onCopy = vi.fn(async () => undefined);
    render(<CodeView code="x" copyLabel="Copy raw source" onCopy={onCopy} />);

    const button = screen.getByRole("button", { name: "Copy raw source" });
    expect(button.getAttribute("title")).toBe("Copy raw source");
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Copied"));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  test("copies the code to the clipboard when there is no owner copy", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CodeView code={"const a = 1;"} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const a = 1;"));
  });

  test("says when the copy did not work, and clears the message after a moment", async () => {
    vi.useFakeTimers();
    const onCopy = vi.fn(async () => {
      throw new Error("denied");
    });
    render(<CodeView code="x" onCopy={onCopy} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toBe("Copy unavailable");

    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(screen.getByRole("status").textContent).toBe("");
  });

  test("clears the copied message after a moment", async () => {
    vi.useFakeTimers();
    const onCopy = vi.fn(async () => undefined);
    render(<CodeView code="x" onCopy={onCopy} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toBe("Copied");

    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
