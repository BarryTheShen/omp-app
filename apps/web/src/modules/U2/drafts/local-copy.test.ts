import { FolderPath } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { createDraftBuffer, type DraftBufferStorage } from "./draft-buffer";
import { DraftController } from "./drafts";
import { ScopedDraftStore } from "./test-support";

const folderScope = { kind: "folder", folder: FolderPath.parse("/workspace/app") } as const;

/** Storage at its quota: every write fails while `full.value` is true, and the rest works as usual. */
function storageAtQuota(full: { value: boolean }): DraftBufferStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (full.value) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe("a draft whose browser copy the browser refuses", () => {
  test("is reported on the snapshot while the browser refuses writes, and clears after a write that works", async () => {
    const full = { value: true };
    const controller = new DraftController({
      store: new ScopedDraftStore(),
      scope: folderScope,
      buffer: createDraftBuffer(storageAtQuota(full), () => undefined),
    });
    await controller.load();

    controller.setDraft("typed while the browser is full", []);
    expect(controller.getSnapshot().text).toBe("typed while the browser is full");
    expect(controller.getSnapshot().localCopyRefused).toBe(true);

    full.value = false;
    controller.setDraft("typed after the browser has room", []);
    expect(controller.getSnapshot().localCopyRefused).toBe(false);
  });
});
