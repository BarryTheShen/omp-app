import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  type ThreadMessage,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  test("opens safe links in a new tab with a visible destination", async () => {
    render(<MarkdownHarness text="[Read docs](https://example.test/docs)" />);
    const link = await screen.findByRole("link", { name: "Read docs" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("(https://example.test/docs)")).toBeTruthy();
  });

  test("renders partial fences and GFM tables without a second renderer", async () => {
    render(<MarkdownHarness text={"```ts\nconst value = 1"} />);
    expect(document.querySelector("[data-markdown-code]")).toBeTruthy();
    expect(document.querySelector("[data-code-language]")?.textContent).toBe("ts");

    cleanup();
    render(<MarkdownHarness text={"| A | B |\n| --- | --- |\n| one | two |"} />);
    expect(document.querySelector("[data-markdown-table]")).toBeTruthy();
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
    expect(document.querySelector("[data-markdown-code]")).toBeTruthy();
  });
});
