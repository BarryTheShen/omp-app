import type { FolderPath } from "@omp-app/contracts";
import { AppFailure, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type {
  DialogHost,
  DialogHostOpenOptions,
  DialogRequest,
  DialogResult,
  DialogResultFor,
} from "@/modules/U4/contract";
import type { AdvisorConfigController, AdvisorConfigState } from "./advisor";
import { openAdvisorConfiguration } from "./dialog";

const threadId = ThreadId.parse("advisor-dialog-thread");
const folder = "/workspace/project" as FolderPath;

function answered(request: DialogRequest, value: string): DialogResult {
  return {
    outcome: "answered",
    response: { kind: request.kind === "input" ? "input" : "select", value },
  } as DialogResult;
}

function readyState(): AdvisorConfigState {
  return {
    phase: "ready",
    entries: [],
    layer: "global",
    revision: "rev-1" as AdvisorConfigState["revision"],
    error: null,
  };
}

function fakeController(
  write: (key: string, value: unknown) => Promise<void>,
  read: () => Promise<AdvisorConfigState>,
): AdvisorConfigController {
  const state = readyState();
  return {
    getSnapshot: () => state,
    subscribe: () => () => undefined,
    read,
    write: async (key, value) => {
      await write(key, value);
      return state;
    },
    dispose: () => undefined,
  };
}

class ScriptedDialogs implements DialogHost {
  readonly requests: DialogRequest[] = [];
  readonly options: DialogHostOpenOptions[] = [];
  readonly confirmations: DialogRequest[] = [];
  private readonly answers: readonly string[];

  constructor(answers: readonly string[]) {
    this.answers = answers;
  }

  async open<R extends DialogRequest>(
    request: R,
    options: DialogHostOpenOptions,
  ): Promise<DialogResultFor<R>> {
    this.requests.push(request);
    this.options.push(options);
    const answer = this.answers[this.requests.length - 1];
    if (answer === undefined || answer === "Cancel" || answer === "Close") {
      return { outcome: "cancelled", kind: request.kind, timedOut: false } as DialogResultFor<R>;
    }
    return answered(request, answer) as DialogResultFor<R>;
  }

  async confirm(request: Extract<DialogRequest, { kind: "confirm" }>): Promise<boolean> {
    this.confirmations.push(request);
    return true;
  }
}

describe("advisor configuration dialog", () => {
  test("uses the app-origin DialogHost and writes the selected setting through the typed store", async () => {
    const dialogs = new ScriptedDialogs(["Global settings", "Enable Advisor", "On", "Close"]);
    const writes: Array<[string, unknown]> = [];
    const controller = fakeController(
      async (key, value) => {
        writes.push([key, value]);
      },
      async () => readyState(),
    );
    await openAdvisorConfiguration({
      dialogs,
      controllerForLayer: () => controller,
      threadId,
      folder,
    });
    expect(dialogs.options.every((options) => options.origin === "app")).toBe(true);
    expect(writes).toEqual([["advisor.enabled", true]]);
  });

  test("reads the latest revision before retrying a conflict with the staged value", async () => {
    const dialogs = new ScriptedDialogs([
      "Global settings",
      "Advisor Review Interval",
      "3",
      "Close",
    ]);
    const conflict = new AppFailure({
      code: "conflict",
      message: "Changed elsewhere",
      retryable: true,
    });
    const events: string[] = [];
    let writes = 0;
    const controller = fakeController(
      async (key, value) => {
        events.push(`write:${key}:${value}`);
        writes += 1;
        if (writes === 1) throw conflict;
      },
      async () => {
        events.push("read");
        return readyState();
      },
    );
    await openAdvisorConfiguration({
      dialogs,
      controllerForLayer: () => controller,
      threadId,
      folder,
    });
    expect(events).toEqual([
      "read",
      "write:advisor.reviewInterval:3",
      "read",
      "write:advisor.reviewInterval:3",
    ]);
  });

  test.each(["abc", "0", "-2", "1.5"])(
    "confirms invalid value %s and asks for the number again before writing",
    async (invalid) => {
      const dialogs = new ScriptedDialogs([
        "Global settings",
        "Advisor Review Interval",
        invalid,
        "2",
        "Close",
      ]);
      const writes: Array<[string, unknown]> = [];
      const controller = fakeController(
        async (key, value) => {
          writes.push([key, value]);
        },
        async () => readyState(),
      );
      await openAdvisorConfiguration({
        dialogs,
        controllerForLayer: () => controller,
        threadId,
        folder,
      });
      expect(dialogs.confirmations).toHaveLength(1);
      expect(dialogs.confirmations[0]).toMatchObject({ title: "That number is not valid" });
      expect(dialogs.requests.map((request) => request.kind)).toEqual([
        "select",
        "select",
        "input",
        "input",
        "select",
      ]);
      expect(writes).toEqual([["advisor.reviewInterval", 2]]);
    },
  );
});
