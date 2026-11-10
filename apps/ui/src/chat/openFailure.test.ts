import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { lostWithTheLink, openFailureAction, openFailureText } from "./openFailure";

const failed = (startup?: "no_model" | "no_credentials" | "other") =>
  new AppFailure({
    code: "omp_exited",
    message: "omp stopped while it was starting. Try again.",
    retryable: true,
    ...(startup === undefined ? {} : { startup }),
  });

describe("why a chat could not open", () => {
  test("omp stopped for want of a model: the words say so and where to choose one, not to try again", () => {
    const text = openFailureText(failed("no_model"));
    expect(text).toContain("no model is set up");
    expect(text).toContain("omp-app tui");
    expect(text).not.toContain("Try again");
  });

  test("each startup reason gets its own words; a failure without one keeps its own", () => {
    const words = new Set(
      (["no_model", "no_credentials", "other"] as const).map((reason) =>
        openFailureText(failed(reason)),
      ),
    );
    expect(words.size).toBe(3);
    expect(openFailureText(failed())).toBe(
      "Could not open this chat: omp stopped while it was starting. Try again.",
    );
    expect(openFailureText(new Error("Session file is not listed"))).toBe(
      "Could not open this chat: Session file is not listed",
    );
  });

  test("a chat the server no longer has says so in plain words, with New chat; so does one whose omp stopped as it started", () => {
    const missing = new AppFailure({
      code: "not_found",
      message: "Thread 01a1b3f2-0cfe-7293-8022-9e1d8b689bc7 was not found",
      retryable: false,
    });
    expect(openFailureText(missing)).toBe(
      "Could not open this chat: the app's server no longer has it.",
    );
    expect(openFailureAction(missing)).toBe("new-chat");
    expect(openFailureAction(failed("no_model"))).toBe("new-chat");
  });

  test("any other failure gets Try again; only a lost link opens the chat again by itself", () => {
    const timedOut = new AppFailure({
      code: "unavailable",
      message: "Connection to the app server timed out",
      retryable: true,
    });
    expect(openFailureAction(timedOut)).toBe("reopen");
    expect(openFailureAction(failed())).toBe("reopen");
    expect(openFailureAction(new Error("Session file is not listed"))).toBe("reopen");
    expect(lostWithTheLink(timedOut)).toBe(true);
    expect(lostWithTheLink(failed())).toBe(false);
    expect(
      lostWithTheLink(
        new AppFailure({ code: "unavailable", message: "memory is off", retryable: false }),
      ),
    ).toBe(false);
    expect(lostWithTheLink(new Error("network"))).toBe(false);
  });
});
