import type { CapabilityMap } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  modeForText,
  parseComposerMode,
  pythonModeAvailability,
  shouldExitMode,
  submitModeInput,
  textForMode,
} from "./modes";

const promptCapabilities: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "rpc" },
  "omp.cmd.bash": { state: "available", via: "rpc" },
  "upstream.python-mode": {
    state: "unavailable",
    via: "upstream",
    detail: "Python mode is not released",
  },
};

describe("U2.6 composer modes", () => {
  test("parses plain text, !cmd, and !!cmd exactly", () => {
    expect(parseComposerMode("hello")).toEqual({ mode: "prompt", text: "hello" });
    expect(parseComposerMode("!printf hello")).toEqual({ mode: "bash", text: "printf hello" });
    expect(parseComposerMode("!!printf hello")).toEqual({
      mode: "bash",
      text: "printf hello",
      excludeFromContext: true,
    });
    expect(parseComposerMode("$HOME")).toEqual({ mode: "prompt", text: "$HOME" });
  });
  test("derives live mode from typing/deleting prefixes and clicks", () => {
    expect(modeForText("")).toBe("prompt");
    expect(modeForText("!")).toBe("bash");
    expect(modeForText("!ls")).toBe("bash");
    expect(modeForText("ls")).toBe("prompt");
    expect(textForMode("ls", "bash")).toBe("!ls");
    expect(textForMode("!ls", "prompt")).toBe("ls");
    expect(textForMode("!!ls", "prompt")).toBe("ls");
  });

  test("does not exit prompt mode and exits bash/python on Escape or empty Backspace", () => {
    expect(shouldExitMode("prompt", "Escape", "")).toBe(false);
    expect(shouldExitMode("bash", "Escape", "cmd")).toBe(true);
    expect(shouldExitMode("python", "Backspace", "")).toBe(true);
    expect(shouldExitMode("python", "Backspace", "code")).toBe(false);
  });

  test("gates Python with the capability reason", async () => {
    expect(pythonModeAvailability(promptCapabilities)).toEqual({
      available: false,
      reason: "Python mode is not released",
    });
    const submitPrompt = vi.fn(async () => undefined);
    await expect(
      submitModeInput(
        { mode: "python", text: "print(1)" },
        "new",
        promptCapabilities,
        submitPrompt,
      ),
    ).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "upstream.python-mode" },
    });
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  test("submits bash through the one PromptIntent callback", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    await submitModeInput(
      { mode: "bash", text: "printf hello", excludeFromContext: true },
      "new",
      promptCapabilities,
      submitPrompt,
    );
    expect(submitPrompt).toHaveBeenCalledWith({
      mode: "bash",
      text: "printf hello",
      delivery: "new",
      excludeFromContext: true,
    });
  });
});
