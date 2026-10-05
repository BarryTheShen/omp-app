import type { CapabilityMap } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  type ComposerDraft,
  defaultSubmitPolicy,
  isModeAvailable,
  modeCapability,
  resolveSubmitPolicy,
  restoreDraft,
} from "./contract";

const draft: ComposerDraft = {
  text: "draft",
  images: [],
  attachmentRefs: [{ id: "file-1", name: "notes.txt", mediaType: "text/plain" }],
};

describe("U2.1 composer contracts", () => {
  test("defaults idle submits to new and streaming submits to steer", () => {
    expect(defaultSubmitPolicy({ isStreaming: false, keyChord: "enter", draft })).toEqual({
      delivery: "new",
    });
    expect(defaultSubmitPolicy({ isStreaming: true, keyChord: "enter", draft })).toEqual({
      delivery: "steer",
    });
  });

  test("rejects a policy that implicitly starts a new run while streaming", () => {
    let error: unknown;
    try {
      resolveSubmitPolicy(() => ({ delivery: "new" }), {
        isStreaming: true,
        keyChord: "enter",
        draft,
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({
      appError: {
        code: "invalid_args",
        message: "A turn is running: choose steer or follow-up",
      },
    });
  });

  test("rejects empty split plans and preserves valid ordered split plans", () => {
    let error: unknown;
    try {
      resolveSubmitPolicy(() => ({ split: [] }), {
        isStreaming: false,
        keyChord: "enter",
        draft,
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({ appError: { code: "invalid_args" } });
    const result = resolveSubmitPolicy(
      () => ({
        split: [
          { mode: "prompt", text: "one", delivery: "new" },
          { mode: "prompt", text: "two", delivery: "followUp" },
        ],
      }),
      { isStreaming: false, keyChord: "enter", draft },
    );
    expect(result).toEqual({
      split: [
        { mode: "prompt", text: "one", delivery: "new" },
        { mode: "prompt", text: "two", delivery: "followUp" },
      ],
    });
  });

  test("restores exact draft text and attachment order without sharing the input array", () => {
    const attachments = [
      { id: "a", name: "a.txt", mediaType: "text/plain" },
      { id: "b", name: "b.png", mediaType: "image/png" },
    ] as const;
    const restored = restoreDraft("exact text", attachments);
    expect(restored).toEqual({ text: "exact text", attachmentRefs: attachments });
    expect(restored.attachmentRefs).not.toBe(attachments);
  });

  test("maps mode gates to the released or upstream capability", () => {
    expect(modeCapability("prompt")).toBe("omp.cmd.prompt");
    expect(modeCapability("bash")).toBe("omp.cmd.bash");
    expect(modeCapability("python")).toBe("upstream.python-mode");
    const capabilities: CapabilityMap = {
      "omp.cmd.prompt": { state: "available", via: "rpc" },
      "omp.cmd.bash": { state: "available", via: "rpc" },
      "upstream.python-mode": { state: "unavailable", via: "upstream" },
    };
    expect(isModeAvailable("prompt", capabilities)).toBe(true);
    expect(isModeAvailable("bash", capabilities)).toBe(true);
    expect(isModeAvailable("python", capabilities)).toBe(false);
  });
});
