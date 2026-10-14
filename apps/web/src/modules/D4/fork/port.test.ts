import { AppFailure, FolderPath, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { createShareImportPort, type ShareImportClient } from "./port";

const THREAD = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");
const FOLDER = FolderPath.parse("/workspace/project");
const LINK = "https://my.omp.sh/s/abc1234567#key";

/** A1.12's result as the server writes it, file path and source URL included. */
const WIRE_RESULT = {
  threadId: THREAD,
  sessionFile: "/home/user/.omp/agent/sessions/imported.jsonl",
  title: "Shared chat",
  sourceKind: "omp-share",
  sourceShareUrl: LINK,
  artifactStatus: "preserved",
  artifactWarnings: [],
};

interface Call {
  args: unknown;
  options: unknown;
}

function clientAnswering(answer: () => Promise<unknown>): {
  client: ShareImportClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      import(args, options) {
        calls.push({ args, options });
        return answer();
      },
    },
  };
}

async function failureOf(promise: Promise<unknown>): Promise<AppFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppFailure) return error;
    throw error;
  }
  throw new Error("Expected the import to fail.");
}

describe("createShareImportPort", () => {
  test("sends the share link as an omp share source with the folder to A1.12", async () => {
    const controller = new AbortController();
    const { client, calls } = clientAnswering(() => Promise.resolve(WIRE_RESULT));
    await createShareImportPort(client).importShare(LINK, FOLDER, controller.signal);
    expect(calls).toEqual([
      {
        args: { sourceKind: "omp-share", sourceRef: LINK, folder: FOLDER },
        options: { signal: controller.signal },
      },
    ]);
  });

  test("returns the new chat without omp's file path or the source URL", async () => {
    const { client } = clientAnswering(() => Promise.resolve(WIRE_RESULT));
    const result = await createShareImportPort(client).importShare(LINK, FOLDER);
    expect(result).toEqual({
      threadId: THREAD,
      title: "Shared chat",
      artifactStatus: "preserved",
      artifactWarnings: [],
    });
    expect(JSON.stringify(result)).not.toContain("sessions/imported.jsonl");
    expect(JSON.stringify(result)).not.toContain(LINK);
  });

  test("rejects a result that does not match A1.12's shape as internal, and opens no chat", async () => {
    const { client } = clientAnswering(() => Promise.resolve({ threadId: THREAD }));
    const failure = await failureOf(createShareImportPort(client).importShare(LINK, FOLDER));
    expect(failure.appError.code).toBe("internal");
    expect(failure.appError.message).toContain("no chat was opened");
  });

  test("passes an AppFailure from A1.12 through unchanged, so its reason is kept", async () => {
    const original = new AppFailure({
      code: "unavailable",
      message: "The running omp does not expose a non-interactive session import operation.",
      retryable: false,
      capability: "upstream.session-import",
    });
    const { client } = clientAnswering(() => Promise.reject(original));
    expect(await failureOf(createShareImportPort(client).importShare(LINK, FOLDER))).toBe(original);
  });

  test("turns any other error into an internal failure that shows no detail", async () => {
    const { client } = clientAnswering(() =>
      Promise.reject(new Error("socket closed at 10.0.0.4")),
    );
    const failure = await failureOf(createShareImportPort(client).importShare(LINK, FOLDER));
    expect(failure.appError).toEqual({
      code: "internal",
      message: "The shared chat could not be imported for an unexpected reason.",
      retryable: false,
    });
    expect(failure.appError.message).not.toContain("10.0.0.4");
  });
});
