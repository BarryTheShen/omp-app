import type { AppClient } from "@omp-app/client";
import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  createFileMentionProvider,
  createGithubMentionProvider,
  detectMentionTrigger,
  executePromptAction,
  expandMention,
  formatFileMentionInsertion,
  rankFileMentions,
} from "./mentions";

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
        search: (args: unknown) => portCall(port.name, "search", args),
      }) as never,
    subscribe: async () => {
      throw new Error("not used");
    },
    dispose: () => undefined,
  } as unknown as AppClient;
}

describe("D2.4 mention detection and expansion", () => {
  test("detects @ and prefixed GitHub # triggers in the middle of text", () => {
    const fileText = "before @src/app.ts after";
    const fileCursor = fileText.indexOf(" after");
    expect(detectMentionTrigger(fileText, fileCursor)).toEqual({
      trigger: "@",
      query: "src/app.ts",
      range: { start: 7, end: fileCursor },
    });

    const githubText = "fix pr #123 before";
    const githubCursor = githubText.indexOf(" before");
    expect(detectMentionTrigger(githubText, githubCursor)).toEqual({
      trigger: "#",
      query: "123",
      githubKind: "pull-request",
      range: { start: 7, end: githubCursor },
    });
  });

  test("supports quoted paths and line-range insertion text", () => {
    const text = 'see @"src/my file.ts:4-8" now';
    const cursor = text.indexOf('" now');
    expect(detectMentionTrigger(text, cursor)).toEqual({
      trigger: "@",
      query: "src/my file.ts:4-8",
      range: { start: 4, end: cursor },
    });
    expect(
      formatFileMentionInsertion({ path: "src/my file.ts", lineRange: { start: 4, end: 8 } }),
    ).toBe('@"src/my file.ts:4-8" ');
  });

  test("ranks recent files first for an empty query and fuzzy matches otherwise", () => {
    const candidates = [
      { path: "src/app.ts", kind: "file" as const, score: 10 },
      { path: "README.md", kind: "file" as const, score: 0 },
      { path: "src/application.ts", kind: "file" as const, score: 20 },
    ];
    expect(
      rankFileMentions(candidates, "", ["README.md", "src/app.ts"]).map((item) => item.path),
    ).toEqual(["README.md", "src/app.ts", "src/application.ts"]);
    expect(rankFileMentions(candidates, "app").map((item) => item.path)).toEqual([
      "src/app.ts",
      "src/application.ts",
    ]);
  });

  test("keeps exact basename ahead of a higher-scored longer prefix path", () => {
    const ranked = rankFileMentions(
      [
        { path: "src/application.ts", kind: "file", score: 10_000 },
        { path: "src/app.ts", kind: "file", score: 0 },
      ],
      "app",
    );
    expect(ranked.map((item) => item.path)).toEqual(["src/app.ts", "src/application.ts"]);
  });

  test("expands a file candidate into replacement text and an attachment ref", () => {
    const text = "read @src/app.ts now";
    const match = detectMentionTrigger(text, text.indexOf(" now"));
    if (match === null) throw new Error("expected an active file mention");
    const result = expandMention(text, match, {
      id: "file:src/app.ts",
      kind: "file",
      source: "a1.file-search",
      label: "src/app.ts",
      insertText: "@src/app.ts ",
      metadata: { path: "src/app.ts", kind: "file" },
    });
    expect(result).toMatchObject({
      kind: "expanded",
      text: "read @src/app.ts now",
      attachmentRefs: [{ id: "file:src/app.ts", name: "src/app.ts", mediaType: "text/plain" }],
    });
  });
  test("resolves local # actions without sending a prompt", () => {
    expect(executePromptAction("copy-current-line", "first\nsecond line", 10)).toEqual({
      text: "first\nsecond line",
      cursor: 10,
      copyText: "second line",
    });
    expect(executePromptAction("copy-prompt", "first\nsecond line", 2).copyText).toBe(
      "first\nsecond line",
    );
    expect(executePromptAction("cursor-start", "first\nsecond line", 10).cursor).toBe(0);
    expect(executePromptAction("cursor-end", "first\nsecond line", 0).cursor).toBe(17);
    expect(executePromptAction("undo", "first\nsecond line", 4).undo).toBe(true);
  });
});

describe("D2.4 host-backed providers", () => {
  test("returns an explicit unavailable state when GitHub CLI is unavailable", async () => {
    const client = fakeClient(async (name) => {
      if (name === "A1.githubRefs") {
        throw new AppFailure({
          code: "unavailable",
          message: "GitHub CLI (gh) is not available.",
          retryable: false,
          capability: "host.github-refs",
        });
      }
      return { candidates: [], truncated: false };
    });
    const provider = createGithubMentionProvider({ client, folder: "/workspace" as never });
    const result = await provider.searchTyped("123");
    expect(result.state).toBe("unavailable");
    expect(result.error).toMatchObject({
      state: "unavailable",
      error: { code: "unavailable", message: "GitHub CLI (gh) is not available." },
    });
  });

  test("maps current and cross-repository GitHub references to omp URL forms", async () => {
    const client = fakeClient(async (name) => {
      if (name === "A1.githubRefs") {
        return {
          candidates: [
            {
              kind: "pull-request",
              number: 42,
              title: "Fix completion",
              body: "",
              url: "https://github.com/BarryTheShen/omp-app/pull/42",
              state: "open",
              repository: "BarryTheShen/omp-app",
            },
          ],
          truncated: false,
        };
      }
      return { candidates: [], truncated: false };
    });
    const crossRepository = createGithubMentionProvider({ client, folder: "/workspace" as never });
    const crossResult = await crossRepository.searchTyped("pr 42");
    expect(crossResult.candidates).toEqual([
      expect.objectContaining({
        kind: "github",
        label: "pr #42",
        description: "Fix completion · open",
        insertText: "pr://BarryTheShen/omp-app/42 ",
      }),
    ]);

    const currentRepository = createGithubMentionProvider({
      client,
      folder: "/workspace" as never,
      currentRepository: "BarryTheShen/omp-app",
    });
    const currentResult = await currentRepository.searchTyped("pr 42");
    expect(currentResult.candidates).toEqual([expect.objectContaining({ insertText: "pr://42 " })]);
  });

  test("maps file-search candidates and preserves line-range queries", async () => {
    let received: unknown;
    const client = fakeClient(async (name, _method, args) => {
      if (name === "A1.fileSearch") {
        received = args;
        return { results: [{ path: "src/app.ts", kind: "file", score: 100 }], truncated: false };
      }
      return { candidates: [], truncated: false };
    });
    const provider = createFileMentionProvider({ client, folder: "/workspace" as never });
    const result = await provider.searchTyped("src/app.ts:4-8");
    expect(received).toMatchObject({ query: "src/app.ts", limit: 30 });
    expect(result.candidates[0]).toMatchObject({
      kind: "file",
      insertText: "@src/app.ts:4-8 ",
      metadata: { path: "src/app.ts", lineRange: { start: 4, end: 8 } },
    });
  });
});
