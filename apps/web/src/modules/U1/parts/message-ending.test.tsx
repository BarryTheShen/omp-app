import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { endingOf, MessageEndingNote } from "./message-ending";

afterEach(() => cleanup());

const assistant = (status: { type: string; reason?: string; error?: unknown }) => ({
  role: "assistant",
  status,
});

describe("endingOf", () => {
  test("an error carries omp's own words; without any, it still is an error", () => {
    expect(
      endingOf(assistant({ type: "incomplete", reason: "error", error: "404 not found" })),
    ).toEqual({
      kind: "error",
      text: "404 not found",
    });
    expect(endingOf(assistant({ type: "incomplete", reason: "error" }))).toEqual({
      kind: "error",
      text: undefined,
    });
  });

  test("a stop is an interruption and the length limit is its own ending", () => {
    expect(endingOf(assistant({ type: "incomplete", reason: "cancelled" }))).toEqual({
      kind: "interrupted",
    });
    expect(endingOf(assistant({ type: "incomplete", reason: "length" }))).toEqual({
      kind: "length",
    });
  });

  test("a finished or running answer, another incomplete reason, and a message that is not an answer have none", () => {
    expect(endingOf(assistant({ type: "complete", reason: "stop" }))).toBeUndefined();
    expect(endingOf(assistant({ type: "running" }))).toBeUndefined();
    expect(endingOf(assistant({ type: "incomplete", reason: "other" }))).toBeUndefined();
    expect(
      endingOf({ role: "user", status: { type: "incomplete", reason: "error" } }),
    ).toBeUndefined();
    expect(endingOf({ role: "assistant" })).toBeUndefined();
  });
});

describe("MessageEndingNote", () => {
  test("an error says so with its reason, as an alert", () => {
    render(
      <MessageEndingNote ending={{ kind: "error", text: "model: claude-opus-5-5 not found" }} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("The model stopped with an error");
    expect(screen.getByRole("alert").textContent).toContain("model: claude-opus-5-5 not found");
  });

  test("an error with no words still says it stopped", () => {
    render(<MessageEndingNote ending={{ kind: "error", text: undefined }} />);
    expect(screen.getByRole("alert").textContent).toBe("The model stopped with an error");
  });

  test("a long reason is cut, not dumped", () => {
    render(<MessageEndingNote ending={{ kind: "error", text: "x".repeat(2_000) }} />);
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text.length).toBeLessThan(700);
    expect(text.endsWith("…")).toBe(true);
  });

  test("an interruption and the length limit are calm lines, not alerts", () => {
    render(<MessageEndingNote ending={{ kind: "interrupted" }} />);
    expect(screen.getByText("Interrupted")).toBeTruthy();
    cleanup();
    render(<MessageEndingNote ending={{ kind: "length" }} />);
    expect(screen.getByText("Cut off at the length limit")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
