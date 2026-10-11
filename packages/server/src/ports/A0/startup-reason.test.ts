import { describe, expect, test } from "bun:test";
import { startupReason } from "./startup-reason";

describe("startupReason", () => {
  test("omp's no-model exit (its words on stderr) is no_model", () => {
    const stderr = [
      "No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.",
      "Set an API key environment variable:",
      "  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.",
      "Or create /home/someone/.omp/agent/models.yml",
    ].join("\n");
    expect(startupReason(stderr)).toBe("no_model");
  });

  test("a chosen model without its key is no_credentials", () => {
    expect(startupReason("No API key found for openai.\n")).toBe("no_credentials");
  });

  test("a crash, an unknown exit, or no stderr at all is other", () => {
    expect(startupReason("")).toBe("other");
    expect(startupReason("Segmentation fault (core dumped)\n")).toBe("other");
  });

  test("the no-model words win over the key words that come with them", () => {
    expect(startupReason("No default model selected. Set an API key environment variable.")).toBe(
      "no_model",
    );
  });
});
