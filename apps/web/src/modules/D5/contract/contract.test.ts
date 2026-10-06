import type { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  D5_COMMAND_CAPABILITIES,
  HandoffResult,
  SessionActionAvailability,
  SessionCommandResult,
  SessionInfoMetadata,
  SshHost,
  WorkspaceDirectorySnapshot,
} from ".";

const threadId = "d5-thread" as ThreadId;
const cwd = "/workspace/project";
const sessionFile = "/workspace/project/.omp/session.jsonl";

describe("D5 typed contracts", () => {
  test("keeps session ids, cwd paths and session-file paths distinct", () => {
    const metadata = SessionInfoMetadata.parse({
      id: threadId,
      title: "Chat",
      cwd,
      sessionFile,
    });
    expect(metadata.id).toBe(threadId);
    expect(SessionInfoMetadata.safeParse({ ...metadata, cwd: "relative" }).success).toBe(false);
    expect(
      SessionInfoMetadata.safeParse({ ...metadata, sessionFile: "/workspace/not-a-session" })
        .success,
    ).toBe(false);
  });

  test("models typed command results and capability availability", () => {
    expect(
      SessionCommandResult.parse({
        status: "unavailable",
        error: {
          code: "unavailable",
          message: "Deletion is unavailable for this connection.",
          retryable: false,
          capability: D5_COMMAND_CAPABILITIES.delete,
        },
      }).status,
    ).toBe("unavailable");
    expect(
      SessionActionAvailability.parse({
        state: "unavailable",
        capability: D5_COMMAND_CAPABILITIES.rename,
        reason: "Rename is unavailable for this connection.",
      }),
    ).toMatchObject({
      state: "unavailable",
      capability: "omp.cmd.set_session_name",
      reason: expect.any(String),
    });
    expect(D5_COMMAND_CAPABILITIES.pin).toBe("host.session-pins");
  });

  test("keeps handoff and directory results typed and rejects private-key material", () => {
    expect(
      HandoffResult.parse({ savedPath: null, summaryEntryId: null, sessionSettled: true }),
    ).toMatchObject({ sessionSettled: true });
    expect(
      WorkspaceDirectorySnapshot.parse({
        cwd,
        additionalDirectories: ["/workspace/shared"],
        revision: "r1",
      }).additionalDirectories,
    ).toEqual(["/workspace/shared"]);
    expect(
      SshHost.safeParse({
        name: "build",
        host: "build.example",
        scope: "project",
        privateKey: "not accepted",
      }).success,
    ).toBe(false);
    expect(
      SshHost.parse({
        name: "build",
        host: "build.example",
        scope: "project",
        keyLabel: "deploy-key",
      }),
    ).toMatchObject({ keyLabel: "deploy-key" });
  });
});
