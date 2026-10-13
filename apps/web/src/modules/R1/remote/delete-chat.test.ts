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
  test("reads the chat, then asks the server to delete its file: the chat's view is not let go before the server decides", async () => {
    const calls: string[] = [];
    await deleteChatFile({
      threadId: threadA,
      catalog: catalogFetching(async () => {
        calls.push("fetch");
        return session();
      }),
      sessionFiles: sessionFilesRecording(calls),
    });

    expect(calls).toEqual(["fetch", "delete /workspace/app /workspace/app/.omp/thread-a.jsonl"]);
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
      }),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });

    expect(calls).toEqual([]);
  });

  test("a refusal from the server reaches the caller unchanged, with its code", async () => {
    const refusal = new AppFailure({
      code: "conflict",
      message: "Wait for this chat's turn to finish, then delete it.",
      retryable: true,
    });
    const calls: string[] = [];
    await expect(
      deleteChatFile({
        threadId: threadA,
        catalog: catalogFetching(async () => session()),
        sessionFiles: sessionFilesRecording(calls, refusal),
      }),
    ).rejects.toBe(refusal);
  });
});
