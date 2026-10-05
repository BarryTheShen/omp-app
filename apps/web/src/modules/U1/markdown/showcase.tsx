import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  type ThreadMessage,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useMemo } from "react";
import { MarkdownText } from "./markdown-text";

const RICH_MARKDOWN = `# Rich Markdown answer

Here is **bold text**, \`inline code\`, and a [safe link](https://example.test/docs).

> A blockquote stays readable while the answer streams.

- one item
- two items

| State | Result |
| --- | --- |
| running | partial |
| done | settled |

\`\`\`ts
const answer = "streaming-safe";
\`\`\``;

export function MarkdownShowcase() {
  const messages = useMemo<readonly ThreadMessage[]>(
    () => [
      {
        role: "assistant",
        id: "markdown-showcase",
        content: [{ type: "text", text: RICH_MARKDOWN }],
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
      } as unknown as ThreadMessage,
    ],
    [],
  );
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
              <section
                aria-label="Rich Markdown answer"
                className="border-border bg-background mx-auto w-full max-w-3xl border-t px-6 py-6"
                data-markdown-showcase
              >
                <MessagePrimitive.Parts>
                  {({ part }) => (part.type === "text" ? <MarkdownText /> : null)}
                </MessagePrimitive.Parts>
              </section>
            </MessagePrimitive.Root>
          )}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
