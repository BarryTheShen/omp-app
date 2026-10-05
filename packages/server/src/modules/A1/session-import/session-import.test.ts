import { describe, expect, test } from "bun:test";
import { AppFailure, type SessionImportArgs } from "@omp-app/contracts";
import { SessionImportStoreService } from "./store";

const folder = "/workspace/project" as SessionImportArgs["folder"];

async function expectFailure(promise: Promise<unknown>): Promise<AppFailure> {
  try {
    await promise;
    throw new Error("Expected an AppFailure.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppFailure);
    return error as AppFailure;
  }
}

describe("SessionImportStoreService", () => {
  test("reports the upstream capability when omp has no import bridge", async () => {
    const store = new SessionImportStoreService();
    const error = await expectFailure(
      store.import({
        sourceKind: "claude",
        sourceRef: "/home/user/.claude/projects/session.jsonl",
        folder,
      }),
    );
    expect(error.appError).toMatchObject({
      code: "unavailable",
      capability: "upstream.session-import",
      retryable: false,
    });
    expect(error.appError.message).not.toContain(".claude");
  });

  test("rejects malformed foreign paths and share URLs before the upstream gate", async () => {
    const store = new SessionImportStoreService();
    await expectFailure(
      store.import({ sourceKind: "codex", sourceRef: "relative.jsonl", folder }),
    ).then((error) => expect(error.appError.code).toBe("invalid_args"));
    await expectFailure(
      store.import({ sourceKind: "omp-share", sourceRef: "http://share.example/session", folder }),
    ).then((error) => expect(error.appError.code).toBe("invalid_args"));
    await expectFailure(
      store.import({ sourceKind: "claude", sourceRef: "/workspace/foreign\n.jsonl", folder }),
    ).then((error) => expect(error.appError.code).toBe("invalid_args"));

    const validShare = await expectFailure(
      store.import({ sourceKind: "omp-share", sourceRef: "https://share.example/session", folder }),
    );
    expect(validShare.appError).toMatchObject({
      code: "unavailable",
      capability: "upstream.session-import",
    });
  });

  test("honors a pre-aborted call", async () => {
    const controller = new AbortController();
    controller.abort();
    const store = new SessionImportStoreService();
    await expectFailure(
      store.import(
        { sourceKind: "claude", sourceRef: "/home/user/session.jsonl", folder },
        controller.signal,
      ),
    ).then((error) => expect(error.appError.code).toBe("cancelled"));
  });
});
