import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  type ThreadMessage,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MarkdownText } from "../../markdown/markdown-text";
import { MarkdownShowcase } from "../../markdown/showcase";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function MarkdownHarness({ text }: { readonly text: string }) {
  const messages: readonly ThreadMessage[] = [
    {
      role: "assistant",
      id: "markdown-test",
      content: [{ type: "text", text }],
      status: { type: "complete", reason: "stop" },
      metadata: { custom: {} },
    } as unknown as ThreadMessage,
  ];
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: false,
    onNew: async () => undefined,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages>
          {() => (
            <MessagePrimitive.Root>
              <MessagePrimitive.Parts>
                {({ part }) => (part.type === "text" ? <MarkdownText /> : null)}
              </MessagePrimitive.Parts>
            </MessagePrimitive.Root>
          )}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

describe("U1.4 Markdown renderer", () => {
  test("keeps raw HTML/XSS inert", async () => {
    render(<MarkdownHarness text={'safe <script>alert("xss")</script> text'} />);
    expect(document.querySelector("script")).toBeNull();
    expect(await screen.findByText(/safe/)).toBeTruthy();
  });

  test("opens safe links in a new tab, and the address is the tooltip rather than text after the link", async () => {
    render(<MarkdownHarness text="[Read docs](https://example.test/docs)" />);
    const link = await screen.findByRole("link", { name: "Read docs" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("title")).toBe("https://example.test/docs");
    expect(screen.queryByText("(https://example.test/docs)")).toBeNull();
  });

  test("a link whose text names another host shows its address after a break opportunity, so a narrow line breaks before it and not inside its scheme", async () => {
    render(<MarkdownHarness text="[docs.example.test](https://other.example.net/login)" />);
    const link = await screen.findByRole("link", { name: "docs.example.test" });
    const destination = screen.getByText("(https://other.example.net/login)");
    expect(link.nextElementSibling?.tagName).toBe("WBR");
    expect(link.nextElementSibling?.nextElementSibling).toBe(destination);
    // The break opportunity adds no text: what is copied stays the same.
    expect(link.parentElement?.textContent).toBe(
      "docs.example.test(https://other.example.net/login)",
    );
  });

  test("renders partial fences and GFM tables without a second renderer", async () => {
    render(<MarkdownHarness text={"```ts\nconst value = 1"} />);
    expect(document.querySelector("[data-code-view]")).toBeTruthy();
    expect(document.querySelector("[data-code-language]")?.textContent).toBe("typescript");

    cleanup();
    render(<MarkdownHarness text={"| A | B |\n| --- | --- |\n| one | two |"} />);
    expect(document.querySelector("[data-markdown-table]")).toBeTruthy();
  });

  test("a c++ fence is labelled and coloured as C++, not read as C", async () => {
    render(<MarkdownHarness text={"```c++\nint main() { return 0; }\n```"} />);

    expect(document.querySelector("[data-code-language]")?.textContent).toBe("cpp");
    await waitFor(
      () =>
        expect(document.querySelector("[data-code-state]")?.getAttribute("data-code-state")).toBe(
          "highlighted",
        ),
      { timeout: 10_000 },
    );
  });

  test("copies a code block through its accessible copy button", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<MarkdownHarness text={'```js\nconsole.log("copy")\n```'} />);
    const copy = await screen.findByRole("button", { name: "Copy code" });
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith('console.log("copy")');
  });

  test("showcase includes headings, links, code and tables", async () => {
    render(<MarkdownShowcase />);
    expect(await screen.findByRole("heading", { name: "Rich Markdown answer" })).toBeTruthy();
    expect(document.querySelector("[data-markdown-table]")).toBeTruthy();
    expect(document.querySelector("[data-code-view]")).toBeTruthy();
  });
});
