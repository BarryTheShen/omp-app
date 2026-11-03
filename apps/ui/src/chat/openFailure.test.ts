import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { openFailureText } from "./openFailure";

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
});
