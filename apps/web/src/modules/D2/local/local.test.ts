import type { AppClient } from "@omp-app/client";
import { describe, expect, test } from "vitest";
import type { MentionProvider } from "../contract";
import {
  createEmojiProvider,
  createInternalUrlProvider,
  detectEmojiTrigger,
  detectInternalUrlTrigger,
  expandEmoji,
  expandEmoticons,
  expandInternalUrl,
  internalUrlSchemes,
  isInsideCode,
  tryEmojiInlineReplace,
} from "./index";

function fakeClient(
  portCall: (name: string, method: string, args: unknown) => Promise<unknown>,
): AppClient {
  return {
    connectionState: "open",
    instanceId: "test-instance",
    onConnectionState: () => () => undefined,
    onResync: () => () => undefined,
    port: (port: { readonly name: string }) =>
      ({
        list: (args: unknown) => portCall(port.name, "list", args),
      }) as never,
    subscribe: async () => {
      throw new Error("not used");
    },
    dispose: () => undefined,
  } as unknown as AppClient;
}

describe("D2.5 emoji completion and safe expansion", () => {
  test("matches omp shortcode boundaries and emits the full emoji set", async () => {
    const provider = createEmojiProvider();
    const text = "say :smil";
    const match = detectEmojiTrigger(text, text.length);
    expect(match).toEqual({
      prefix: ":smil",
      query: "smil",
      range: { start: 4, end: text.length },
    });
    const result = await provider.searchTyped("smil");
    expect(result.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "😄  :smile:", insertText: "😄" })]),
    );
    expect(detectEmojiTrigger("url:http://host/:smil", 21)).toBeNull();
  });

  test("replaces completed shortcodes but preserves code spans and fenced blocks", () => {
    const text = "say :smile";
    const match = detectEmojiTrigger(text, text.length);
    if (match === null) throw new Error("expected an emoji trigger");
    expect(match).toEqual({ prefix: ":smile", query: "smile", range: { start: 4, end: 10 } });
    const expanded = expandEmoji(text, match, {
      id: "emoji:smile",
      kind: "emoji",
      source: "client",
      label: "😄  :smile:",
      insertText: "😄",
    });
    expect(expanded).toMatchObject({ kind: "expanded", text: "say 😄" });
    expect(tryEmojiInlineReplace("say :smile:")).toEqual({ replaceLength: 7, insert: "😄" });
    expect(expandEmoticons("say :-)")).toBe("say 🙂");
    expect(expandEmoticons("say `:-)`")).toBe("say `:-)`");
    expect(expandEmoticons("```\\nsay :-)\\n```")).toBe("```\\nsay :-)\\n```");
    expect(isInsideCode("say `:smile:", 12)).toBe(true);
  });
});

describe("D2.5 internal URL catalog", () => {
  test("keeps the seven A1 schemes plus D2.4 issue/pr URL forms", () => {
    expect(internalUrlSchemes()).toEqual([
      "skill",
      "rule",
      "omp",
      "local",
      "memory",
      "agent",
      "artifact",
      "issue",
      "pr",
    ]);
  });

  test("queries A1.18 resources without inventing GitHub item entries", async () => {
    let received: unknown;
    const client = fakeClient(async (name, method, args) => {
      if (name === "A1.urlCatalog") {
        received = { method, args };
        return {
          revision: "rev-1",
          resources: [
            {
              scheme: "skill",
              value: "review",
              uri: "skill://review",
              label: "Review skill",
              kind: "skill",
              source: "omp",
            },
          ],
        };
      }
      return { revision: "rev-1", resources: [] };
    });
    const provider = createInternalUrlProvider({ client });
    const result = await provider.searchTyped("skill://rev");
    // The catalog filters by scheme and fuzzy-matches the rest; it cannot match "skill://rev".
    expect(received).toMatchObject({
      method: "list",
      args: { scheme: "skill", query: "rev", limit: 50 },
    });
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "internal-url", insertText: "skill://review " }),
      ]),
    );
    expect(result.revision).toBe("rev-1");
  });

  test("hands numbered issue URLs to D2.4's GitHub provider", async () => {
    const client = fakeClient(async () => ({ revision: "rev-1", resources: [] }));
    const calls: string[] = [];
    const githubProvider: MentionProvider = {
      trigger: "#",
      kind: "github",
      source: "a1.github-refs",
      search: async () => [],
      searchTyped: async (query) => {
        calls.push(query);
        return {
          state: "ready",
          candidates: [
            {
              id: "github:issue:123",
              kind: "github",
              source: "a1.github-refs",
              label: "issue #123",
              insertText: "issue://123 ",
            },
          ],
        };
      },
    };
    const provider = createInternalUrlProvider({ client, githubProvider });
    const result = await provider.searchTyped("issue://123");
    expect(calls).toEqual(["issue 123"]);
    expect(result.candidates).toEqual([
      expect.objectContaining({ id: "github:issue:123", insertText: "issue://123 " }),
    ]);
  });

  test("issue:// and pr:// explain themselves until a number is typed, without the catalog", async () => {
    let catalogCalls = 0;
    const client = fakeClient(async () => {
      catalogCalls += 1;
      return { revision: "rev-1", resources: [] };
    });
    const provider = createInternalUrlProvider({ client });
    const empty = await provider.searchTyped("pr://");
    expect(empty.candidates).toEqual([
      expect.objectContaining({ label: "Pull request by number", insertText: "pr://" }),
    ]);
    expect((await provider.searchTyped("issue://abc")).candidates).toEqual([]);
    const unavailable = await provider.searchTyped("issue://12");
    expect(unavailable.state).toBe("unavailable");
    expect(catalogCalls).toBe(0);
  });

  test("a complete omp scheme lists only that scheme's resources", async () => {
    let received: unknown;
    const client = fakeClient(async (_name, _method, args) => {
      received = args;
      return { revision: "rev-2", resources: [] };
    });
    const provider = createInternalUrlProvider({ client });
    const result = await provider.searchTyped("rule://");
    expect(received).toMatchObject({ scheme: "rule", query: "" });
    expect(result.candidates.some((candidate) => candidate.metadata?.builtin === true)).toBe(false);
  });

  test("detects URL triggers mid-text and refuses code expansion", () => {
    const text = "open skill://review now";
    const match = detectInternalUrlTrigger(text, text.indexOf(" now"));
    if (match === null) throw new Error("expected an internal URL trigger");
    expect(match).toEqual({ scheme: "skill", query: "review", range: { start: 5, end: 19 } });
    const result = expandInternalUrl(text, match, {
      id: "url:skill://review",
      kind: "internal-url",
      source: "a1.url-catalog",
      label: "Review skill",
      insertText: "skill://review ",
    });
    expect(result).toMatchObject({ kind: "expanded", text: "open skill://review now" });
    const code = "open `skill://review`";
    const codeMatch = detectInternalUrlTrigger(code, code.length - 1);
    expect(codeMatch).toBeNull();
  });
});
