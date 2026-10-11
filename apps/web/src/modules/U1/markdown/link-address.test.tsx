import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { MarkdownContent } from "./markdown-content";

afterEach(() => cleanup());

/** What a reader sees of one link: its text, the tooltip that carries its address, and any visible address. */
interface LinkShown {
  readonly text: string;
  readonly title: string | null;
  readonly address: string | null;
}

async function linkShown(markdown: string): Promise<LinkShown> {
  const { container } = render(<MarkdownContent text={markdown} />);
  const link = await screen.findByRole("link");
  return {
    text: link.textContent ?? "",
    title: link.getAttribute("title"),
    address: container.querySelector("[data-link-destination]")?.textContent ?? null,
  };
}

describe("a link's address (issue #825)", () => {
  test.each([
    [
      "plain text: the address is the tooltip, not written next to the text",
      "[link to example](https://example.com/page)",
      { text: "link to example", title: "https://example.com/page", address: null },
    ],
    [
      "same host: a text that names the href's own host shows no address",
      "[example.com](https://example.com/page)",
      { text: "example.com", title: "https://example.com/page", address: null },
    ],
    [
      "other host: a text that names another host keeps its address, a disguised link",
      "[example.com](https://evil.test/login)",
      { text: "example.com", title: null, address: "(https://evil.test/login)" },
    ],
    [
      "bare URL: the URL is the text, so it shows once",
      "https://example.org",
      { text: "https://example.org", title: null, address: null },
    ],
    [
      "text with a scheme, other host: keeps its address",
      "[https://example.com](https://evil.test/login)",
      { text: "https://example.com", title: null, address: "(https://evil.test/login)" },
    ],
    [
      "text with a scheme, same host: shows once",
      "[https://example.com/page](https://example.com/page)",
      { text: "https://example.com/page", title: null, address: null },
    ],
    [
      "www prefix on the same host counts as the same host",
      "[www.example.com](https://example.com/page)",
      { text: "www.example.com", title: "https://example.com/page", address: null },
    ],
    [
      "a dotted word that reads like a host name is treated as one, so it keeps its address",
      "[Node.js](https://nodejs.org/)",
      { text: "Node.js", title: null, address: "(https://nodejs.org/)" },
    ],
  ])("%s", async (_name, markdown, expected) => {
    expect(await linkShown(markdown)).toEqual(expected);
  });
});

describe("the same rule inside one line of prose", () => {
  test("a plain link and a bare URL in one sentence each show once", async () => {
    const { container } = render(
      <MarkdownContent text="A [link to example](https://example.com/page) and a bare https://example.org link." />,
    );
    await screen.findByRole("link", { name: "link to example" });
    expect(container.querySelectorAll("[data-link-destination]")).toHaveLength(0);
    expect(container.textContent).toBe("A link to example and a bare https://example.org link.");
  });
});
