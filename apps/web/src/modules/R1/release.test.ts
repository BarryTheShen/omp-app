import { AppFailure, ThreadId } from "@omp-app/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { releaseThread } from "./release";

const threadId = ThreadId.parse("thread-one");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("releaseThread", () => {
  test("a failure that points at a bug is still logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const close = async (): Promise<never> => {
      throw new AppFailure({
        code: "omp_error",
        message: "omp refused the close",
        retryable: false,
      });
    };

    await releaseThread(close, threadId);

    expect(logged).toHaveBeenCalledTimes(1);
  });

  test("a launch the server refused, because it restarted, holds nothing here and is not logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const close = async (): Promise<never> => {
      throw new AppFailure({
        code: "permission",
        message: "Launch token is not valid",
        retryable: false,
      });
    };

    await releaseThread(close, threadId);

    expect(logged).not.toHaveBeenCalled();
  });
});
