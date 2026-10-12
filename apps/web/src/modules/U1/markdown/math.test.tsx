import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { MarkdownContent } from "./markdown-content";

afterEach(() => cleanup());

/** The reply text in the screenshot from issue #1167: six inline formulas, bold text and a list. */
const SCREENSHOT_TEXT = [
  "The y-axis is really **total** energy, $E = KE + V$, where $V$ is potential energy. The levels are pure KE only because the model sets:",
  "",
  "- $V = 0$ everywhere inside the box ($0 < x < L$)",
  "- $V = \\infty$ at the walls and everywhere outside them",
  "",
  "So inside the box, $E_n = KE + 0 = n^2,\\frac{h^2}{8mL^2}$.",
].join("\n");

describe("math in assistant messages (issue #1167)", () => {
  test("the screenshot's formulas are typeset, and no dollar sign is left as text", () => {
    const { container } = render(<MarkdownContent text={SCREENSHOT_TEXT} />);
    expect(container.querySelectorAll(".katex")).toHaveLength(6);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(0);
    expect(container.textContent).not.toContain("$");
    expect(container.querySelector("strong")?.textContent).toBe("total");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  test("ordinary dollar signs in prose stay text", () => {
    const { container } = render(<MarkdownContent text="It costs $5 and $10 in total." />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toBe("It costs $5 and $10 in total.");
  });

  test("a price before a formula does not swallow the formula", () => {
    const { container } = render(
      <MarkdownContent text="The price is $5, and $E = mc^2$ is the rule." />,
    );
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(container.textContent).toContain("The price is $5, and ");
  });

  test("a price range is text, and a formula after it is typeset", () => {
    const { container } = render(<MarkdownContent text={"The range is $3-$5, so $x = 4$ fits."} />);
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(container.textContent).toContain("The range is $3-$5, so ");
  });

  test("display math written between $$ lines is a display formula", () => {
    const { container } = render(
      <MarkdownContent
        text={"The energy is\n\n$$\nE_n = \\frac{n^2 h^2}{8 m L^2}\n$$\n\nfor a box."}
      />,
    );
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(container.textContent).not.toContain("$$");
  });

  test("the \\( \\) and \\[ \\] forms models write are typeset", () => {
    const { container } = render(
      <MarkdownContent text={"Inline \\(a + b\\) and display:\n\n\\[x^2 + y^2 = r^2\\]"} />,
    );
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(container.textContent).not.toContain("\\");
  });

  test("a formula across a line break in a paragraph is one formula", () => {
    const { container } = render(<MarkdownContent text={"Here \\(a +\nb\\) ends."} />);
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
  });

  test("display math inside a quote is a display formula", () => {
    const { container } = render(<MarkdownContent text={"> $$\n> E = mc^2\n> $$"} />);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(container.textContent).not.toContain("$$");
  });

  test("a formula in a list item is typeset", () => {
    const { container } = render(
      <MarkdownContent text={"- the box: $V = 0$\n- the walls: $V = \\infty$"} />,
    );
    expect(container.querySelectorAll("li .katex")).toHaveLength(2);
  });

  test("Markdown marks inside a formula stay part of the formula", () => {
    const { container } = render(<MarkdownContent text={"Write $a*b*c$ as one formula."} />);
    expect(container.querySelector("em")).toBeNull();
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
  });

  test("an escaped dollar sign is a dollar sign, and a formula beside it is typeset", () => {
    const { container } = render(<MarkdownContent text={"Costs \\$5 and $x$."} />);
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(container.textContent).toContain("Costs $5 and ");
  });

  test("a price before a code span does not swallow the code span", () => {
    const { container } = render(<MarkdownContent text={"It costs $10, see `$x$` here."} />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("code[data-markdown-inline]")?.textContent).toBe("$x$");
  });

  test("inline code and code blocks keep their dollar signs and are never typeset", async () => {
    const { container } = render(
      <MarkdownContent text={"Write `$x$` as code.\n\n```text\n$y = mx + b$\n```"} />,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("code[data-markdown-inline]")?.textContent).toBe("$x$");
    await waitFor(() => expect(container.textContent).toContain("$y = mx + b$"));
  });

  test.each([
    [
      "an unclosed $...$ at the end of the text",
      "The energy is $E_n = \\frac{n^2",
      "The energy is $E_n = \\frac{n^2 h^2}{8 m L^2}$.",
      "$E_n = \\frac{n^2",
      ".katex",
    ],
    [
      "an unclosed $$ block with no closing line",
      "The energy is\n\n$$\n\\psi_n(x) = \\sqrt{",
      "The energy is\n\n$$\n\\psi_n(x) = \\sqrt{2}\n$$",
      "$$\n\\psi_n(x) = \\sqrt{",
      ".katex-display",
    ],
    [
      "an unclosed \\( formula",
      "The energy is \\(E_1 = \\frac{h^2",
      "The energy is \\(E_1 = \\frac{h^2}{8mL^2}\\).",
      "\\(E_1 = \\frac{h^2",
      ".katex",
    ],
    [
      "an unclosed \\[ formula",
      "The energy is\n\n\\[E_1 = \\frac{h^2",
      "The energy is\n\n\\[E_1 = \\frac{h^2}{8mL^2}\\]",
      "\\[E_1 = \\frac{h^2",
      ".katex-display",
    ],
  ])(
    "%s is shown as its source while open, and typeset once it closes",
    (_name, open, closed, source, typeset) => {
      const { container, rerender } = render(<MarkdownContent text={open} />);
      expect(container.querySelector(".katex, .katex-error")).toBeNull();
      expect(container.textContent).toContain(source);

      rerender(<MarkdownContent text={closed} />);
      expect(container.querySelector(typeset)).not.toBeNull();
      expect(container.querySelector(".katex-error, .math-source")).toBeNull();
      expect(container.textContent).not.toContain(source);
    },
  );

  test("a complete formula KaTeX cannot read is shown as its source, not as an error", () => {
    const { container } = render(<MarkdownContent text={"Try $\\notacommand{x}$ here."} />);
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.textContent).toBe("Try $\\notacommand{x}$ here.");
  });

  test("math cannot add links, markup or script", () => {
    const { container } = render(
      <MarkdownContent
        text={
          "Link $\\href{https://example.com/x}{x}$, class $\\htmlClass{evil}{x}$, script <script>alert(1)</script>."
        }
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".evil")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("\\href{https://example.com/x}{x}");
  });
});
