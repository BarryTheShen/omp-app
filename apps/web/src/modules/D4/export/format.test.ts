import { describe, expect, test } from "vitest";
import { createCopySourceReader } from "../copy";
import { realChatEntries } from "../copy/fixtures/real-chat";
import { chatAsMarkdown, chatAsPlainText } from "./format";

/** The first prompt of the recorded chat: a TypeScript block, a shell block and a bash tool call. */
const PROMPT = [
  "Here is a snippet:",
  "```ts",
  "const answer = 42;",
  "```",
  "And a shell step:",
  "```bash",
  "echo inside",
  "```",
  "run_bash",
].join("\n");

function recordedMessages() {
  return createCopySourceReader()(realChatEntries());
}

describe("chatAsMarkdown", () => {
  test("omp's reply comes right after the prompt, under omp's heading", () => {
    const markdown = chatAsMarkdown(recordedMessages());
    expect(markdown.startsWith(`## You\n\n${PROMPT}\n\n## omp\n\ntool said: fixture-tool`)).toBe(
      true,
    );
  });

  test("the tool's own result is left out: the only headings are the person's and omp's", () => {
    const markdown = chatAsMarkdown(recordedMessages());
    expect(markdown.match(/^## .+$/gm)).toEqual(["## You", "## omp", "## You", "## omp", "## You"]);
    expect(markdown).not.toMatch(/^fixture-tool/m);
  });

  test("keeps the transcript order: every reply follows the prompt it answers", () => {
    const markdown = chatAsMarkdown(recordedMessages());
    const first = markdown.indexOf("## omp\n\n");
    expect(first).toBeGreaterThan(markdown.indexOf("## You\n\n"));
    expect(markdown.indexOf("## You\n\n", first)).toBeGreaterThan(first);
    expect(markdown).toContain("pong");
  });

  test("an empty chat exports as no text", () => {
    expect(chatAsMarkdown([])).toBe("");
  });
});

describe("chatAsPlainText", () => {
  test("labels each message, and omp's reply follows the prompt with its Markdown marks as written", () => {
    const plain = chatAsPlainText(recordedMessages());
    // U1.7's plain text for a text part is its source, so a fence stays a fence. The export says so.
    expect(plain.startsWith(`You:\n${PROMPT}\n\nomp:\ntool said: fixture-tool`)).toBe(true);
    expect(plain.match(/^(You|omp):$/gm)).toEqual(["You:", "omp:", "You:", "omp:", "You:"]);
  });

  test("an empty chat exports as no text", () => {
    expect(chatAsPlainText([])).toBe("");
  });
});
