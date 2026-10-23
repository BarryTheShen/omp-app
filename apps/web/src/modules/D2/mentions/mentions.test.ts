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
  hashListName,
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
      referenceRange: { start: 4, end: githubCursor },
    });
  });

  test("'pull #12' is a pull request reference, as omp reads the pull qualifier", () => {
    expect(detectMentionTrigger("pull #12")).toMatchObject({
      trigger: "#",
      query: "12",
      githubKind: "pull-request",
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
  test("a # followed by a space is a heading, so no trigger opens for it (issue 1333)", () => {
    expect(detectMentionTrigger("# Plan")).toBeNull();
    // The caret right after the # is still inside the heading.
    expect(detectMentionTrigger("# Plan", 1)).toBeNull();
    expect(detectMentionTrigger("#\nPlan", 1)).toBeNull();
    expect(detectMentionTrigger("Notes\n# Plan\nsteps")).toBeNull();
    // The heading is the nearest #, so an earlier reference does not stretch over it.
    expect(detectMentionTrigger("fixes #12\n# Plan")).toBeNull();
    // A reference after a heading still opens, and a bare # still opens the action list.
    expect(detectMentionTrigger("# Plan #12")).toEqual({
      trigger: "#",
      query: "12",
      range: { start: 7, end: 10 },
    });
    expect(detectMentionTrigger("#")).toEqual({
      trigger: "#",
      query: "",
      range: { start: 0, end: 1 },
    });
  });
  test("a # reference ends at its first space: text past it is prose, not a reference (issue 1340)", () => {
    const text = "see #12 for details";
    expect(detectMentionTrigger(text)).toBeNull();
    expect(detectMentionTrigger("see #12\nnext line")).toBeNull();
    // With the caret right after the reference, the reference is still live.
    expect(detectMentionTrigger(text, 7)).toEqual({
      trigger: "#",
      query: "12",
      range: { start: 4, end: 7 },
    });
  });
  test("a pr or issue word typed before a # reference is part of it, so a chosen row replaces it (issue 1381)", () => {
    expect(detectMentionTrigger("see pr #12")).toEqual({
      trigger: "#",
      query: "12",
      githubKind: "pull-request",
      range: { start: 7, end: 10 },
      referenceRange: { start: 4, end: 10 },
    });
    expect(detectMentionTrigger("see issue #5")).toEqual({
      trigger: "#",
      query: "5",
      githubKind: "issue",
      range: { start: 10, end: 12 },
      referenceRange: { start: 4, end: 12 },
    });
    // The word can start the text, and a word that only ends in pr is not the kind of a reference.
    expect(detectMentionTrigger("pr #12")).toMatchObject({ referenceRange: { start: 0, end: 6 } });
    expect(detectMentionTrigger("see repr #12")).toEqual({
      trigger: "#",
      query: "12",
      range: { start: 9, end: 12 },
    });
  });
  test("a chosen pr or issue row replaces the typed word with its link, and an action row leaves the word (issue 1381)", () => {
    const pr = "see pr #12";
    const prMatch = detectMentionTrigger(pr);
    if (prMatch === null) throw new Error("expected a GitHub reference");
    expect(
      expandMention(pr, prMatch, {
        id: "github:current:pr:12",
        kind: "github",
        source: "a1.github-refs",
        label: "pr #12",
        insertText: "pr://12 ",
      }),
    ).toMatchObject({ kind: "expanded", text: "see pr://12 " });
    const issue = "see issue #5";
    const issueMatch = detectMentionTrigger(issue);
    if (issueMatch === null) throw new Error("expected a GitHub reference");
    expect(
      expandMention(issue, issueMatch, {
        id: "github:current:issue:5",
        kind: "github",
        source: "a1.github-refs",
        label: "issue #5",
        insertText: "issue://5 ",
      }),
    ).toMatchObject({ kind: "expanded", text: "see issue://5 " });
    // An action row removes only the # it was typed at, as it did before: the word is not part of an action.
    expect(
      expandMention(pr, prMatch, {
        id: "action:copy-prompt",
        kind: "prompt-action",
        source: "client",
        label: "Copy whole prompt",
        metadata: { action: "copy-prompt" },
      }),
    ).toMatchObject({ kind: "expanded", text: "see pr " });
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
  test("moves the caret to the start and the end of the line it is on", () => {
    const text = "first\nsecond line";
    expect(executePromptAction("cursor-line-start", text, 10)).toEqual({ text, cursor: 6 });
    expect(executePromptAction("cursor-line-end", text, 10)).toEqual({ text, cursor: 17 });
    expect(executePromptAction("cursor-line-end", text, 2)).toEqual({ text, cursor: 5 });
    expect(executePromptAction("cursor-line-start", text, 0)).toEqual({ text, cursor: 0 });
    expect(executePromptAction("cursor-line-start", text, 6)).toEqual({ text, cursor: 6 });
    expect(executePromptAction("cursor-line-end", "", 0)).toEqual({ text: "", cursor: 0 });
  });
  test("lists omp's action rows with their labels and plain descriptions, in the app's order", async () => {
    const client = fakeClient(async () => ({ candidates: [], truncated: false }));
    const provider = createGithubMentionProvider({ client, folder: "/workspace" as never });
    const result = await provider.searchTyped("");
    expect(result.candidates.map(({ label, description }) => [label, description])).toEqual([
      ["Copy current line", "Copies the line the cursor is on"],
      ["Copy whole prompt", "Copies everything typed so far"],
      ["Undo", "Takes back the last word typed"],
      ["Move cursor to message start", "Moves the cursor to the start of the message"],
      ["Move cursor to message end", "Moves the cursor to the end of the message"],
      ["Move cursor to line start", "Moves the cursor to the start of this line"],
      ["Move cursor to line end", "Moves the cursor to the end of this line"],
    ]);
    for (const { description } of result.candidates) {
      expect(description, `${description} reads as words, not an id`).not.toMatch(/#|[a-z]-[a-z]/);
    }
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
    const result = await provider.searchTyped("issue login");
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
    const crossResult = await crossRepository.searchTyped("pr login");
    expect(crossResult.candidates).toEqual([
      expect.objectContaining({
        kind: "github",
        label: "PR #42",
        description: "Fix completion · open",
        insertText: "pr://BarryTheShen/omp-app/42 ",
      }),
    ]);

    const currentRepository = createGithubMentionProvider({
      client,
      folder: "/workspace" as never,
      currentRepository: "BarryTheShen/omp-app",
    });
    const currentResult = await currentRepository.searchTyped("pr login");
    expect(currentResult.candidates).toEqual([expect.objectContaining({ insertText: "pr://42 " })]);
  });

  test("a #<number> offers omp's PR and Issue rows, built here: GitHub is not asked, so a refused gh changes nothing", async () => {
    const asked: string[] = [];
    const client = fakeClient(async (name) => {
      asked.push(name);
      throw new AppFailure({
        code: "unavailable",
        message: "GitHub CLI (gh) is not available.",
        retryable: false,
        capability: "host.github-refs",
      });
    });
    const provider = createGithubMentionProvider({ client, folder: "/workspace" as never });
    const result = await provider.searchTyped("123");
    expect(result.state).toBe("ready");
    expect(result.error).toBeUndefined();
    expect(
      result.candidates.map(({ label, description, insertText }) => [
        label,
        description,
        insertText,
      ]),
    ).toEqual([
      ["PR #123", "GitHub pull request", "pr://123 "],
      ["Issue #123", "GitHub issue", "issue://123 "],
    ]);
    expect(asked).toEqual([]);
  });

  test("naming the type offers only that kind: 'pr 123' is one PR row, 'issue 123' one Issue row, and 0 is no reference", async () => {
    const client = fakeClient(async () => {
      throw new Error("GitHub is not asked for a number");
    });
    const provider = createGithubMentionProvider({ client, folder: "/workspace" as never });
    const pr = await provider.searchTyped("pr 123");
    expect(pr.candidates.map(({ label, insertText }) => [label, insertText])).toEqual([
      ["PR #123", "pr://123 "],
    ]);
    const issue = await provider.searchTyped("issue 123");
    expect(issue.candidates.map(({ label, insertText }) => [label, insertText])).toEqual([
      ["Issue #123", "issue://123 "],
    ]);
    expect((await provider.searchTyped("0")).candidates).toEqual([]);
  });

  test("the # list is named for its rows: a number or a pr or issue search is GitHub's, omp's actions are Message actions", () => {
    expect(hashListName("")).toBe("Message actions");
    expect(hashListName("copy")).toBe("Message actions");
    expect(hashListName("123")).toBe("GitHub suggestions");
    expect(hashListName("pr 123")).toBe("GitHub suggestions");
    expect(hashListName("issue login")).toBe("GitHub suggestions");
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
