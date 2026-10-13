import { describe, expect, test } from "bun:test";
import { AppFailure, SessionFilePath, ThreadId } from "@omp-app/contracts";
import type { A1PortContext } from "./context";
import { resolveChatSessionFile } from "./paste-file-store";

const openThread = ThreadId.parse("thread-open-new");
const openFile = SessionFilePath.parse(
  "/home/user/.omp/agent/sessions/-work/2026_thread-open-new.jsonl",
);
const savedThread = ThreadId.parse("thread-saved");
const savedFile = SessionFilePath.parse(
  "/home/user/.omp/agent/sessions/-work/2026_thread-saved.jsonl",
);

function contextWith(
  findSession: (
    id: string,
  ) => Promise<{ readonly id: string; readonly sessionFile: string } | undefined>,
): Pick<A1PortContext, "openSessionFile" | "sessionFileStore"> {
  return {
    openSessionFile: (threadId) => (threadId === openThread ? openFile : undefined),
    sessionFileStore: { findSession } as unknown as A1PortContext["sessionFileStore"],
  };
}

describe("resolve the session file a paste is saved beside", () => {
  test("an open chat's session file is used before omp writes it to disk, without reading the disk", async () => {
    const context = contextWith(async () => {
      throw new Error("the disk must not be read for an open chat");
    });

    expect(await resolveChatSessionFile(context, openThread)).toBe(openFile);
  });

  test("a chat that is not open is found by its session file on disk", async () => {
    const context = contextWith(async (id) =>
      id === savedThread ? { id, sessionFile: savedFile } : undefined,
    );

    expect(await resolveChatSessionFile(context, savedThread)).toBe(savedFile);
  });

  test("an unknown chat fails as not found, with a message that names no path", async () => {
    const context = contextWith(async () => undefined);

    const failure: unknown = await resolveChatSessionFile(
      context,
      ThreadId.parse("thread-none"),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppFailure);
    if (!(failure instanceof AppFailure)) throw new Error("expected an AppFailure");
    expect(failure.appError.code).toBe("not_found");
    expect(failure.appError.message).not.toContain("/home/user");
  });
});
