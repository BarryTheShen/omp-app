import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { endingOf, MessageEndingNote } from "./message-ending";
import { splitProviderError } from "./provider-error";

afterEach(() => cleanup());

const SAVED_REQUEST = "/example/omp-home/logs/http-400-requests/request.json";
/** omp's text for a provider 400: its message, its body (the message again, with the type), and the saved request. */
const OMP_TEXT = [
  "400 fake provider failure for the failing subagent",
  "fake provider failure for the failing subagent (type=invalid_request_error)",
  `raw-http-request=${SAVED_REQUEST}`,
].join("\n");
const REASON = "400 fake provider failure for the failing subagent (type=invalid_request_error)";

describe("splitProviderError", () => {
  test("says the provider's words once and moves the saved request behind details", () => {
    expect(splitProviderError(OMP_TEXT)).toEqual({
      reason: REASON,
      details: `Request log: ${SAVED_REQUEST}`,
    });
  });

  test("a message with no repeat and no saved request is kept as it is", () => {
    expect(splitProviderError("404 model not found")).toEqual({
      reason: "404 model not found",
      details: undefined,
    });
  });

  test("a failed save is said in plain words, behind details", () => {
    expect(
      splitProviderError("400 bad block\nraw-http-request-save-failed=EACCES: permission denied"),
    ).toEqual({
      reason: "400 bad block",
      details: "The request log could not be saved: EACCES: permission denied",
    });
  });

  test("two lines that say different things are both kept, joined with a space", () => {
    expect(splitProviderError("400 bad block\nmessages.0 has no content").reason).toBe(
      "400 bad block messages.0 has no content",
    );
  });
});

describe("the failing answer's ending", () => {
  test("shows the provider's words once, with no saved-request path in the sentence", () => {
    const ending = endingOf({
      role: "assistant",
      status: { type: "incomplete", reason: "error", error: OMP_TEXT },
    });
    if (ending === undefined) throw new Error("the failing answer has no ending");
    render(<MessageEndingNote ending={ending} />);

    const alert = screen.getByRole("alert");
    const phrase = "fake provider failure for the failing subagent";
    expect(alert.textContent?.split(phrase).length).toBe(2);
    expect(alert.textContent).not.toContain("raw-http-request=");
    expect(screen.getByText("Show details").closest("details")?.textContent).toContain(
      SAVED_REQUEST,
    );
  });
});
