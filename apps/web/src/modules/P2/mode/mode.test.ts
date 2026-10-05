import type { PlanDocument, PlanDocumentInput } from "@omp-app/contracts";
import { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { PlanDocumentStoreSource } from "../contract";
import { PlanModeController, type PlanModePort } from "./mode";

const threadId = ThreadId.parse("p2-mode-test");
const document: PlanDocument = {
  id: "plan-mode-test",
  threadId,
  markdown: "# Plan\n",
  sections: [{ id: "plan", heading: "Plan", start: 0, end: 1 }],
  annotations: [],
  status: "draft",
  revision: 1,
  updatedAt: "2026-10-05T00:00:00.000Z",
};

function source(): PlanDocumentStoreSource {
  return {
    load: async () => ({ document, revisions: [] }),
    save: async (input: PlanDocumentInput, expectedRevision: number) => ({
      document: { ...input, revision: expectedRevision + 1, updatedAt: "2026-10-05T00:00:01.000Z" },
      revisions: [],
    }),
    export: async (documentId, format) => ({ documentId, format, text: document.markdown }),
    subscribeChanged: () => () => undefined,
  };
}

describe("PlanModeController", () => {
  test("loads host draft and gates authoritative toggle with omp reason", async () => {
    const controller = new PlanModeController({ store: source(), threadId });
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "planning",
      authority: "host",
      canToggle: false,
    });
    await expect(controller.toggle()).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "upstream.plan-mode" },
    });
    expect(controller.getSnapshot().capabilityReason).toBe(
      "Plan mode can't be switched from the app yet: omp 18.6.1 doesn't offer it over RPC.",
    );
    controller.dispose();
  });

  test("saves host drafts through the PlanDocumentStore without claiming upstream mode", async () => {
    const controller = new PlanModeController({ store: source(), threadId });
    await controller.load();
    const saved = await controller.saveDraft({ ...document, markdown: "# Updated\n" });
    expect(saved.document?.markdown).toBe("# Updated\n");
    expect(saved.authority).toBe("host");
    controller.dispose();
  });

  test("uses a typed upstream port only when capability is available", async () => {
    const calls: string[] = [];
    const port: PlanModePort = {
      enter: async () => {
        calls.push("enter");
      },
      exit: async () => {
        calls.push("exit");
      },
    };
    const controller = new PlanModeController({
      store: source(),
      threadId,
      port,
      capability: { state: "available", via: "upstream" },
    });
    await controller.load();
    await controller.toggle();
    expect(calls).toEqual(["exit"]);
    controller.dispose();
  });
});
