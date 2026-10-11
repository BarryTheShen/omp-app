import { AppFailure, FolderPath, SessionFilePath, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { SessionMetadata } from "../contract";
import { deleteChatFile, type SessionFileDelete } from "./delete-chat";
import type { RemoteThreadCatalogSource } from "./remote";

const threadA = ThreadId.parse("thread-a");
const folder = FolderPath.parse("/workspace/app");
const sessionFile = SessionFilePath.parse("/workspace/app/.omp/thread-a.jsonl");

function session(): SessionMetadata {
  return { id: threadA, sessionFile, cwd: folder } as unknown as SessionMetadata;
}

function catalogFetching(fetch: () => Promise<SessionMetadata>): RemoteThreadCatalogSource {
  return { fetch } as unknown as RemoteThreadCatalogSource;
}

function sessionFilesRecording(calls: string[], refusal?: AppFailure): SessionFileDelete {
  return {
    deleteSession: async (args) => {
      calls.push(`delete ${args.folder} ${args.sessionFile}`);
      if (refusal) throw refusal;
      return { id: threadA, sessionFile, removed: true };
    },
  };
}

describe("deleteChatFile", () => {
  test("reads the chat, lets its hold go, then asks the server to delete its file, in that order", async () => {
    const calls: string[] = [];
    await deleteChatFile({
      threadId: threadA,
      catalog: catalogFetching(async () => {
        calls.push("fetch");
        return session();
      }),
      sessionFiles: sessionFilesRecording(calls),
      close: async ({ threadId }) => {
        calls.push(`close ${threadId}`);
        return null;
      },
    });

    expect(calls).toEqual([
      "fetch",
      "close thread-a",
      "delete /workspace/app /workspace/app/.omp/thread-a.jsonl",
    ]);
  });

  test("a chat the server has already forgotten still deletes: the failed release is not a reason to stop", async () => {
    const calls: string[] = [];
    await deleteChatFile({
      threadId: threadA,
      catalog: catalogFetching(async () => session()),
      sessionFiles: sessionFilesRecording(calls),
      close: async () => {
        throw new AppFailure({ code: "not_found", message: "forgotten", retryable: false });
      },
    });

    expect(calls).toEqual(["delete /workspace/app /workspace/app/.omp/thread-a.jsonl"]);
  });

  test("a chat that cannot be read is not sent to the server", async () => {
    const calls: string[] = [];
    await expect(
      deleteChatFile({
        threadId: threadA,
        catalog: catalogFetching(async () => {
          throw new AppFailure({ code: "not_found", message: "gone", retryable: false });
        }),
        sessionFiles: sessionFilesRecording(calls),
        close: async () => null,
      }),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });

    expect(calls).toEqual([]);
  });

  test("a refusal from the server reaches the caller unchanged, with its code", async () => {
    const refusal = new AppFailure({
      code: "conflict",
      message: "Close this chat before deleting it: omp has it open.",
      retryable: true,
    });
    const calls: string[] = [];
    await expect(
      deleteChatFile({
        threadId: threadA,
        catalog: catalogFetching(async () => session()),
        sessionFiles: sessionFilesRecording(calls, refusal),
        close: async () => null,
      }),
    ).rejects.toBe(refusal);
  });
});
