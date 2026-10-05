import { AttachmentRef, ThreadId, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  D2_TRIGGER_DESCRIPTORS,
  FileMentionCandidate,
  GitHubReferenceCandidate,
  InternalUrlCandidate,
  PromptActionCandidate,
  PromptExpansionResult,
  SlashCommand,
  SlashCommandCatalog,
  TriggerCandidate,
  TriggerSearchResult,
} from ".";

describe("D2 typed trigger catalog", () => {
  test("preserves slash source, aliases, subcommands and argument hints", () => {
    const command = SlashCommand.parse({
      name: "review",
      source: "skill",
      aliases: ["r"],
      description: "Review a change",
      input: { hint: "path" },
      subcommands: [{ name: "quick", usage: "/review quick <path>" }],
    });
    expect(command.source).toBe("skill");
    expect(command.aliases).toEqual(["r"]);
    expect(command.subcommands?.[0]?.usage).toContain("quick");
  });

  test("models bounded loading, stale, unavailable and ready catalog states", () => {
    const ready = SlashCommandCatalog.parse({
      state: "ready",
      revision: "commands-4",
      commands: [{ name: "plan", source: "builtin" }],
    });
    expect(ready.state).toBe("ready");
    expect(
      TriggerSearchResult.parse({ state: "stale", revision: "commands-3", candidates: [] }).state,
    ).toBe("stale");
    expect(
      TriggerSearchResult.parse({
        state: "unavailable",
        candidates: [],
        error: {
          state: "unavailable",
          error: { code: "unavailable", message: "offline", retryable: true },
        },
      }).error?.error.code,
    ).toBe("unavailable");
  });

  test("keeps candidate sources and host metadata typed", () => {
    expect(
      TriggerCandidate.parse({
        id: "file:src/index.ts",
        kind: "file",
        source: "a1.file-search",
        label: "src/index.ts",
        insertText: "@src/index.ts ",
      }).source,
    ).toBe("a1.file-search");
    expect(FileMentionCandidate.parse({ path: "src/index.ts", kind: "file", score: 12 }).kind).toBe(
      "file",
    );
    expect(
      GitHubReferenceCandidate.parse({
        kind: "issue",
        number: 42,
        title: "Fix",
        url: "https://github.com/example/repo/issues/42",
        repository: "example/repo",
      }).number,
    ).toBe(42);
    expect(
      InternalUrlCandidate.parse({
        scheme: "skill",
        uri: "skill://review",
        label: "Review",
        source: "omp",
      }).uri,
    ).toBe("skill://review");
    expect(
      PromptActionCandidate.parse({ action: "copy-prompt", label: "Copy prompt" }).action,
    ).toBe("copy-prompt");
  });

  test("keeps expansion as a text edit and never turns it into submission", () => {
    const attachment = AttachmentRef.parse({
      id: "file-1",
      name: "index.ts",
      mediaType: "text/plain",
    });
    const success = PromptExpansionResult.parse({
      kind: "expanded",
      text: "@src/index.ts ",
      replace: { start: 0, end: 4 },
      cursor: 15,
      attachmentRefs: [attachment],
    });
    if (success.kind !== "expanded") throw new Error("Expected expanded result");
    expect(success.attachmentRefs[0]?.id).toBe("file-1");
    const failure = PromptExpansionResult.parse({
      kind: "error",
      error: { code: "invalid_args", message: "Unknown path", retryable: false },
      replace: { start: 0, end: 4 },
      preserveText: true,
    });
    if (failure.kind !== "error") throw new Error("Expected expansion error");
    expect(failure.preserveText).toBe(true);
  });

  test("claims each D2-owned trigger once through C0", () => {
    const covers = D2_TRIGGER_DESCRIPTORS.flatMap((descriptor) => descriptor.covers).sort();
    expect(covers).toEqual([
      "D3.slash-command-autocomplete",
      "D7.emoji-autocomplete-and-inline-replacement",
      "D7.file-autocomplete",
      "D7.github-issue-pr-autocomplete",
      "D7.internal-url-autocomplete",
      "D7.prompt-actions",
    ]);
    expect(validateRegistry(D2_TRIGGER_DESCRIPTORS)).toEqual([]);
    expect(ThreadId.parse("d2-thread")).toBe("d2-thread");
  });
});
