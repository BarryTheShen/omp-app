import type { AppClient } from "@omp-app/client";
import { AppFailure, OmpCommandGateway, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { createShareCommandClient, createSharePort, type ShareCommandClient } from "./port";

const THREAD = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");
const URL_VALUE = "https://my.omp.sh/s/abc1234567#key";

function clientAnswering(value: unknown): ShareCommandClient {
  return { createShare: () => Promise.resolve(value) };
}

function clientFailing(error: unknown): ShareCommandClient {
  return { createShare: () => Promise.reject(error) };
}

async function failureOf(promise: Promise<unknown>): Promise<AppFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppFailure) return error;
    throw error;
  }
  throw new Error("The share was expected to fail.");
}

describe("the share port over A1's typed result", () => {
  test("returns a result of exactly the contract's shape, with a gist and a truncation note", async () => {
    const gist = "https://gist.github.com/example/0123456789abcdef";
    const port = createSharePort(
      clientAnswering({ url: URL_VALUE, gistUrl: gist, truncated: true }),
    );
    await expect(port.createShare(THREAD)).resolves.toEqual({
      url: URL_VALUE,
      gistUrl: gist,
      truncated: true,
    });
  });

  test("returns a result without a gist", async () => {
    const port = createSharePort(clientAnswering({ url: URL_VALUE, truncated: false }));
    await expect(port.createShare(THREAD)).resolves.toEqual({ url: URL_VALUE, truncated: false });
  });

  test("asks the client for the thread it was given", async () => {
    const asked: ThreadId[] = [];
    const port = createSharePort({
      createShare: (threadId) => {
        asked.push(threadId);
        return Promise.resolve({ url: URL_VALUE, truncated: false });
      },
    });
    await port.createShare(THREAD);
    expect(asked).toEqual([THREAD]);
  });

  test("rejects a result that carries a field the contract does not define", async () => {
    const port = createSharePort(
      clientAnswering({ url: URL_VALUE, truncated: false, visibility: "private" }),
    );
    const failure = await failureOf(port.createShare(THREAD));
    expect(failure.appError.code).toBe("internal");
  });

  test("rejects a link that is not https", async () => {
    const port = createSharePort(
      clientAnswering({ url: "http://127.0.0.1:8080/s/abc1234567#key", truncated: false }),
    );
    const failure = await failureOf(port.createShare(THREAD));
    expect(failure.appError.code).toBe("internal");
  });

  test("rejects a result with no truncation flag", async () => {
    const port = createSharePort(clientAnswering({ url: URL_VALUE }));
    const failure = await failureOf(port.createShare(THREAD));
    expect(failure.appError.code).toBe("internal");
  });

  test("never reads a link out of command text: a plain-text answer is rejected", async () => {
    const port = createSharePort(clientAnswering(`Share URL: ${URL_VALUE}`));
    const failure = await failureOf(port.createShare(THREAD));
    expect(failure.appError.code).toBe("internal");
    expect(failure.appError.message).not.toContain(URL_VALUE);
  });

  test("passes an omp-side failure through unchanged, with its retry flag", async () => {
    const original = new AppFailure({
      code: "unavailable",
      message: "The share server did not answer.",
      retryable: true,
    });
    const port = createSharePort(clientFailing(original));
    expect(await failureOf(port.createShare(THREAD))).toBe(original);
  });

  test("turns any other error into an internal failure that keeps its cause", async () => {
    const cause = new Error("socket closed");
    const port = createSharePort(clientFailing(cause));
    const failure = await failureOf(port.createShare(THREAD));
    expect(failure.appError).toEqual({
      code: "internal",
      message: "Sharing did not finish for an unexpected reason.",
      retryable: false,
    });
    expect(failure.cause).toBe(cause);
  });
});

describe("the share command client over the command gateway", () => {
  test("calls OmpCommandGateway.share with the thread and the signal", async () => {
    const ports: unknown[] = [];
    const calls: Array<{ args: unknown; options: unknown }> = [];
    const client = {
      port: (port: unknown) => {
        ports.push(port);
        return {
          share: (args: unknown, options: unknown) => {
            calls.push({ args, options });
            return Promise.resolve({ url: URL_VALUE, truncated: false });
          },
        };
      },
    } as unknown as Pick<AppClient, "port">;
    const controller = new AbortController();
    const value = await createShareCommandClient(client).createShare(THREAD, controller.signal);
    expect(ports).toEqual([OmpCommandGateway]);
    expect(calls).toEqual([{ args: { threadId: THREAD }, options: { signal: controller.signal } }]);
    expect(value).toEqual({ url: URL_VALUE, truncated: false });
  });
});
