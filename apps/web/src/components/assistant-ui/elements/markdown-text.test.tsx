import { TextMessagePartProvider } from "@assistant-ui/react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { MarkdownText } from "./markdown-text";

afterEach(() => cleanup());

test("reasoning text, shown by the stock markdown element, typesets dollar math as messages do (issue #1167)", async () => {
  const { container } = render(
    <TextMessagePartProvider text="The bound state is $E_1 = \frac{h^2}{8mL^2}$, and $V = 0$ inside.">
      <MarkdownText />
    </TextMessagePartProvider>,
  );
  await waitFor(() => expect(container.querySelectorAll(".katex")).toHaveLength(2));
  expect(container.textContent).not.toContain("$");
});
