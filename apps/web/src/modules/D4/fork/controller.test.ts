import { AppFailure, FolderPath, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type {
  DialogHost,
  DialogHostOpenOptions,
  DialogRequest,
  DialogResult,
  DialogResultFor,
} from "@/modules/U4/contract";
import type { ShareImportResultDto } from "../contract";
import {
  createImportController,
  type ImportControllerDeps,
  type ImportOutcome,
} from "./controller";
import type { ShareImportPort } from "./port";

const THREAD = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");
const NEW_THREAD = ThreadId.parse("0b2b2b2b-ea99-72dd-a84a-017f5d3766ef");
const FOLDER = FolderPath.parse("/workspace/project");
const LINK = "https://my.omp.sh/s/abc1234567#key";
const RESULT: ShareImportResultDto = {
  threadId: NEW_THREAD,
  title: "Shared chat",
  artifactStatus: "preserved",
  artifactWarnings: [],
};

const TYPED = (value: string): DialogResult => ({
  outcome: "answered",
  response: { kind: "input", value },
});
const CONFIRMED: DialogResult = {
  outcome: "answered",
  response: { kind: "confirm", confirmed: true },
};
const DENIED: DialogResult = {
  outcome: "answered",
  response: { kind: "confirm", confirmed: false },
};
const CANCELLED: DialogResult = { outcome: "cancelled", kind: "input", timedOut: false };
const DONE: DialogResult = { outcome: "answered", response: { kind: "editor", value: "" } };

/** Answers each question in turn, as U4's DialogHost would, and keeps what was asked. */
class ScriptedDialogs implements DialogHost {
  readonly requests: DialogRequest[] = [];
  readonly options: DialogHostOpenOptions[] = [];
  private readonly answers: DialogResult[];

  constructor(answers: readonly DialogResult[]) {
    this.answers = [...answers];
  }

  open<R extends DialogRequest>(
    request: R,
    options: DialogHostOpenOptions,
  ): Promise<DialogResultFor<R>> {
    this.requests.push(request);
    this.options.push(options);
    const answer = this.answers.shift();
    if (answer === undefined) {
      return Promise.reject(new Error("No answer was scripted for this question."));
    }
    return Promise.resolve(answer as DialogResultFor<R>);
  }

  confirm(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** Records each import it is asked for, and answers with a result or fails. */
class FakeImportPort implements ShareImportPort {
  readonly calls: { sourceRef: string; folder: FolderPath }[] = [];
  private readonly answer: () => Promise<ShareImportResultDto>;

  constructor(answer: () => Promise<ShareImportResultDto>) {
    this.answer = answer;
  }

  importShare(sourceRef: string, folder: FolderPath): Promise<ShareImportResultDto> {
    this.calls.push({ sourceRef, folder });
    return this.answer();
  }
}

interface Harness {
  readonly dialogs: ScriptedDialogs;
  readonly port: FakeImportPort;
  readonly opened: ThreadId[];
  run(): Promise<ImportOutcome>;
}

function harness(
  answers: readonly DialogResult[],
  options: {
    folder?: FolderPath | null;
    importAvailable?: boolean;
    answer?: () => Promise<ShareImportResultDto>;
    openChat?: () => Promise<void>;
  } = {},
): Harness {
  const dialogs = new ScriptedDialogs(answers);
  const port = new FakeImportPort(options.answer ?? (() => Promise.resolve(RESULT)));
  const opened: ThreadId[] = [];
  const folder = options.folder === undefined ? FOLDER : options.folder;
  const importAvailable = options.importAvailable ?? true;
  const deps: ImportControllerDeps = {
    threadId: THREAD,
    folder: () => folder,
    importPort: port,
    importAvailable: () => importAvailable,
    dialogs,
    openChat: (threadId) => {
      opened.push(threadId);
      return options.openChat?.() ?? Promise.resolve();
    },
  };
  const controller = createImportController(deps);
  return { dialogs, port, opened, run: () => controller.importShare() };
}

function failing(error: AppFailure): () => Promise<ShareImportResultDto> {
  return () => Promise.reject(error);
}

describe("the import flow", () => {
  test("refuses while omp cannot import, and asks nothing: no link question, no Confirm, no import", async () => {
    const h = harness([], { importAvailable: false });
    expect(await h.run()).toEqual({ outcome: "refused", why: "unsupported" });
    expect(h.dialogs.requests).toEqual([]);
    expect(h.port.calls).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  test("once omp can import, the link question comes first and Confirm follows it", async () => {
    const h = harness([TYPED(LINK), CONFIRMED]);
    await h.run();
    expect(h.dialogs.requests.map((request) => request.kind)).toEqual(["input", "confirm"]);
  });

  test("refuses before asking anything when the open chat has no folder", async () => {
    const h = harness([], { folder: null });
    expect(await h.run()).toEqual({ outcome: "refused", why: "no-folder" });
    expect(h.dialogs.requests).toEqual([]);
    expect(h.port.calls).toEqual([]);
  });

  test("imports nothing when the link question is cancelled", async () => {
    const h = harness([CANCELLED]);
    expect(await h.run()).toEqual({ outcome: "not-imported" });
    expect(h.port.calls).toEqual([]);
  });

  test("refuses an empty link and asks no confirmation", async () => {
    const h = harness([TYPED("  ")]);
    expect(await h.run()).toEqual({ outcome: "refused", why: "empty-link" });
    expect(h.dialogs.requests).toHaveLength(1);
    expect(h.port.calls).toEqual([]);
  });

  test("refuses a link that is not https and asks no confirmation", async () => {
    const h = harness([TYPED("http://my.omp.sh/s/abc")]);
    expect(await h.run()).toEqual({ outcome: "refused", why: "bad-link" });
    expect(h.dialogs.requests).toHaveLength(1);
    expect(h.port.calls).toEqual([]);
  });

  test("imports nothing when the person declines Confirm", async () => {
    const h = harness([TYPED(LINK), DENIED]);
    expect(await h.run()).toEqual({ outcome: "not-imported" });
    expect(h.port.calls).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  test("the confirmation names only the host, never the link, and says the shared chat is not changed", async () => {
    const h = harness([TYPED(LINK), DENIED]);
    await h.run();
    const confirm = h.dialogs.requests[1];
    expect(confirm).toMatchObject({ kind: "confirm", title: "Import this shared chat?" });
    const message = confirm?.kind === "confirm" ? confirm.message : "";
    expect(message).toContain("my.omp.sh");
    expect(message).toContain("The shared chat itself is not changed.");
    expect(message).toContain("omp will try to make a new chat on this computer");
    expect(message).not.toContain("#key");
  });

  test("imports the trimmed link into the chat's folder, then opens the new chat", async () => {
    const h = harness([TYPED(`  ${LINK} `), CONFIRMED]);
    expect(await h.run()).toEqual({ outcome: "imported", result: RESULT, opened: true });
    expect(h.port.calls).toEqual([{ sourceRef: LINK, folder: FOLDER }]);
    expect(h.opened).toEqual([NEW_THREAD]);
  });

  test("reports the chat as imported but not opened when opening it fails", async () => {
    const h = harness([TYPED(LINK), CONFIRMED], {
      openChat: () => Promise.reject(new Error("the chat is gone")),
    });
    expect(await h.run()).toEqual({ outcome: "imported", result: RESULT, opened: false });
  });

  test("reports missing parts, with the warnings read-only, when an attachment could not come across", async () => {
    const warnings = ["Image 1 could not be copied.", "Image 2 could not be copied."];
    const h = harness([TYPED(LINK), CONFIRMED, DONE], {
      answer: () =>
        Promise.resolve({ ...RESULT, artifactStatus: "unavailable", artifactWarnings: warnings }),
    });
    expect(await h.run()).toEqual({
      outcome: "imported-with-notes",
      result: { ...RESULT, artifactStatus: "unavailable", artifactWarnings: warnings },
      opened: true,
    });
    expect(h.dialogs.requests[2]).toMatchObject({
      kind: "editor",
      readOnly: true,
      prefill: warnings.join("\n"),
    });
    expect(h.opened).toEqual([NEW_THREAD]);
  });

  test("reports missing parts with no notes dialog when the artifacts are unavailable without warnings", async () => {
    const h = harness([TYPED(LINK), CONFIRMED], {
      answer: () => Promise.resolve({ ...RESULT, artifactStatus: "unavailable" }),
    });
    expect(await h.run()).toMatchObject({ outcome: "imported-with-notes", opened: true });
    expect(h.dialogs.requests).toHaveLength(2);
  });

  test("maps the session-import gate to a refusal and makes no chat", async () => {
    const gate = new AppFailure({
      code: "unavailable",
      message: "The running omp does not expose a non-interactive session import operation.",
      retryable: false,
      capability: "upstream.session-import",
    });
    const h = harness([TYPED(LINK), CONFIRMED], { answer: failing(gate) });
    expect(await h.run()).toEqual({ outcome: "refused", why: "unsupported" });
    expect(h.opened).toEqual([]);
  });

  test("maps an invalid link from omp to a refusal", async () => {
    const invalid = new AppFailure({ code: "invalid_args", message: "bad", retryable: false });
    const h = harness([TYPED(LINK), CONFIRMED], { answer: failing(invalid) });
    expect(await h.run()).toEqual({ outcome: "refused", why: "bad-link" });
  });

  test("maps an unreachable share to a retryable failure and opens no chat", async () => {
    const unreachable = new AppFailure({
      code: "unavailable",
      message: "timed out",
      retryable: true,
    });
    const h = harness([TYPED(LINK), CONFIRMED], { answer: failing(unreachable) });
    expect(await h.run()).toEqual({
      outcome: "failed",
      why: "unreachable",
      error: { code: "unavailable", message: "timed out", retryable: true },
    });
    expect(h.opened).toEqual([]);
  });

  test("maps an omp error to a failure with its own code", async () => {
    const ompError = new AppFailure({ code: "omp_error", message: "omp stopped", retryable: true });
    const h = harness([TYPED(LINK), CONFIRMED], { answer: failing(ompError) });
    expect(await h.run()).toMatchObject({ outcome: "failed", why: "omp-error" });
  });

  test("treats a cancelled import as not imported", async () => {
    const cancelled = new AppFailure({ code: "cancelled", message: "cancelled", retryable: false });
    const h = harness([TYPED(LINK), CONFIRMED], { answer: failing(cancelled) });
    expect(await h.run()).toEqual({ outcome: "not-imported" });
  });

  test("turns an unexpected error into an internal failure and never rejects", async () => {
    const h = harness([TYPED(LINK), CONFIRMED], {
      answer: () => Promise.reject(new Error("boom")),
    });
    expect(await h.run()).toEqual({
      outcome: "failed",
      why: "unexpected",
      error: {
        code: "internal",
        message: "The shared chat could not be imported for an unexpected reason.",
        retryable: false,
      },
    });
  });

  test("runs one import at a time: a second call returns the first, with no second question", async () => {
    const h = harness([TYPED(LINK), CONFIRMED]);
    const controller = createImportController({
      threadId: THREAD,
      folder: () => FOLDER,
      importPort: h.port,
      importAvailable: () => true,
      dialogs: h.dialogs,
      openChat: () => Promise.resolve(),
    });
    const first = controller.importShare();
    const second = controller.importShare();
    expect(await first).toEqual(await second);
    expect(h.dialogs.requests).toHaveLength(2);
  });
});
