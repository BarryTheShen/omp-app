import type { ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { DialogHost } from "../../U4/contract/dialog-host";
import { SessionActionsController } from ".";

const threadId = "thread-r1-actions" as ThreadId;

function remote() {
  return {
    rename: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

describe("SessionActionsController", () => {
  test("renames through the typed remote adapter", async () => {
    const adapter = remote();
    const controller = new SessionActionsController({ remote: adapter, threadId });
    await expect(
      controller.rename({ id: "session-1" as ThreadId }, "Renamed"),
    ).resolves.toMatchObject({
      status: "completed",
    });
    expect(adapter.rename).toHaveBeenCalledWith("session-1", "Renamed");
  });

  test("requires U4 confirmation before delete and keeps denial side-effect free", async () => {
    const adapter = remote();
    const confirm = vi.fn<DialogHost["confirm"]>(async () => false);
    const dialogs = { confirm } as unknown as DialogHost;
    const controller = new SessionActionsController({ remote: adapter, dialogs, threadId });
    await expect(
      controller.delete({ id: "session-1" as ThreadId, title: "Chat" }),
    ).resolves.toEqual({
      status: "cancelled",
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  test("deletes only after confirmation and returns typed failure", async () => {
    const adapter = remote();
    const confirm = vi.fn<DialogHost["confirm"]>(async () => true);
    const dialogs = { confirm } as unknown as DialogHost;
    const controller = new SessionActionsController({ remote: adapter, dialogs, threadId });
    await expect(
      controller.delete({ id: "session-1" as ThreadId, title: "Chat" }),
    ).resolves.toMatchObject({
      status: "completed",
    });
    expect(adapter.delete).toHaveBeenCalledWith("session-1");

    adapter.delete.mockRejectedValueOnce(
      new AppFailure({ code: "permission", message: "omp rejected delete", retryable: false }),
    );
    await expect(
      controller.delete({ id: "session-2" as ThreadId, title: "Other" }),
    ).resolves.toMatchObject({
      status: "error",
      error: { appError: { code: "permission" } },
    });
  });

  test("pins with CAS and exposes unavailable state without a pin port", async () => {
    const set = vi.fn(async (args) => ({
      sessionId: args.sessionId,
      pinned: args.pinned,
      revision: "r2",
    }));
    const controller = new SessionActionsController({ remote: remote(), pins: { set }, threadId });
    await expect(controller.setPinned("session-1" as ThreadId, true, "r1")).resolves.toMatchObject({
      status: "completed",
      value: { revision: "r2" },
    });
    expect(set).toHaveBeenCalledWith({
      sessionId: "session-1",
      pinned: true,
      expectedRevision: "r1",
    });

    const unavailable = new SessionActionsController({ remote: remote(), threadId });
    await expect(unavailable.setPinned("session-1" as ThreadId, true, null)).resolves.toMatchObject(
      {
        status: "unavailable",
        error: { appError: { capability: "host.session-pins" } },
      },
    );
  });

  test("keeps foreign import explicit and reports upstream unavailable without a client", async () => {
    const controller = new SessionActionsController({ remote: remote(), threadId });
    await expect(
      controller.importForeign({
        sourceKind: "claude",
        sourceRef: "/foreign/session.jsonl",
        folder: "/workspace/project" as never,
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      error: { appError: { capability: "upstream.session-import" } },
    });
    expect(controller.getImportAvailability()).toMatchObject({
      state: "unavailable",
      capability: "upstream.session-import",
    });
  });
});
