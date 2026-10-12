import { AppFailure, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type {
  DialogHost,
  DialogHostOpenOptions,
  DialogRequest,
  DialogResult,
  DialogResultFor,
} from "@/modules/U4/contract";
import type { ClipboardPort, SharePort, ShareResult } from "../contract";
import type { ShareSettings } from "./confirm";
import { createShareController, type ShareControllerDeps } from "./controller";

const THREAD = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");
const SETTINGS: ShareSettings = {
  serverUrl: "https://my.omp.sh/s",
  store: "blob",
  redactSecrets: true,
};
const LINK: ShareResult = { url: "https://my.omp.sh/s/abc1234567#key", truncated: false };
const CONFIRMED: DialogResult = {
  outcome: "answered",
  response: { kind: "confirm", confirmed: true },
};
const DENIED: DialogResult = {
  outcome: "answered",
  response: { kind: "confirm", confirmed: false },
};
const DISMISSED: DialogResult = { outcome: "cancelled", kind: "confirm", timedOut: false };
const COPY: DialogResult = {
  outcome: "answered",
  response: { kind: "select", value: "Copy the link" },
};
const CLOSE: DialogResult = {
  outcome: "answered",
  response: { kind: "select", value: "Close without copying" },
};
const SAVED: DialogResult = { outcome: "answered", response: { kind: "editor", value: LINK.url } };

/** Answers each question in turn, as U4's DialogHost would, and keeps what was asked and how. */
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

/** Records every upload it is asked for, and answers with the link or fails. */
class FakeSharePort implements SharePort {
  readonly threads: string[] = [];
  private readonly answer: () => Promise<ShareResult>;

  constructor(answer: () => Promise<ShareResult>) {
    this.answer = answer;
  }

  createShare(threadId: ThreadId): Promise<ShareResult> {
    this.threads.push(threadId);
    return this.answer();
  }
}

/** A clipboard that records what it accepted, or refuses every write. */
class FakeClipboard implements ClipboardPort {
  readonly written: string[] = [];
  private readonly refuses: boolean;

  constructor(refuses: boolean) {
    this.refuses = refuses;
  }

  writeText(text: string): Promise<void> {
    if (this.refuses) return Promise.reject(new Error("The clipboard refused the write."));
    this.written.push(text);
    return Promise.resolve();
  }
}

function controllerFor(
  parts: Pick<ShareControllerDeps, "dialogs" | "sharePort"> &
    Partial<Pick<ShareControllerDeps, "clipboard" | "settings" | "onUploading">>,
) {
  return createShareController({
    threadId: THREAD,
    dialogs: parts.dialogs,
    sharePort: parts.sharePort,
    clipboard: parts.clipboard ?? new FakeClipboard(false),
    settings: parts.settings ?? (() => Promise.resolve(SETTINGS)),
    ...(parts.onUploading === undefined ? {} : { onUploading: parts.onUploading }),
  });
}

describe("the share controller", () => {
  test("a refused question sends nothing to omp or a share server", async () => {
    const sharePort = new FakeSharePort(() => Promise.resolve(LINK));
    const dialogs = new ScriptedDialogs([DENIED]);
    await expect(controllerFor({ dialogs, sharePort }).share()).resolves.toEqual({
      outcome: "not-shared",
    });
    expect(sharePort.threads).toEqual([]);
    expect(dialogs.requests).toHaveLength(1);
  });

  test("dismissing the question counts as not shared", async () => {
    const sharePort = new FakeSharePort(() => Promise.resolve(LINK));
    await expect(
      controllerFor({ dialogs: new ScriptedDialogs([DISMISSED]), sharePort }).share(),
    ).resolves.toEqual({ outcome: "not-shared" });
    expect(sharePort.threads).toEqual([]);
  });

  test("a confirmed share uploads once for this chat, then offers to copy the link", async () => {
    const sharePort = new FakeSharePort(() => Promise.resolve(LINK));
    const clipboard = new FakeClipboard(false);
    const dialogs = new ScriptedDialogs([CONFIRMED, COPY]);
    const outcome = await controllerFor({ dialogs, sharePort, clipboard }).share();
    expect(outcome).toEqual({ outcome: "copied", result: LINK });
    expect(sharePort.threads).toEqual([THREAD]);
    expect(clipboard.written).toEqual([LINK.url]);
    expect(dialogs.requests[1]).toMatchObject({
      kind: "select",
      title: "Share link ready",
      options: ["Copy the link", "Close without copying"],
    });
  });

  test("the question is app-origin for this chat, and its id begins with app-", async () => {
    const dialogs = new ScriptedDialogs([DENIED]);
    await controllerFor({
      dialogs,
      sharePort: new FakeSharePort(() => Promise.resolve(LINK)),
    }).share();
    expect(dialogs.options[0]).toMatchObject({ threadId: THREAD, origin: "app" });
    expect(dialogs.requests[0]).toMatchObject({ kind: "confirm" });
    expect(dialogs.requests[0]?.id.startsWith("app-")).toBe(true);
  });

  test("the question names the settings read when it is asked, not the ones from an earlier share", async () => {
    let settings: ShareSettings = SETTINGS;
    const dialogs = new ScriptedDialogs([DENIED, DENIED]);
    const controller = controllerFor({
      dialogs,
      sharePort: new FakeSharePort(() => Promise.resolve(LINK)),
      settings: () => Promise.resolve(settings),
    });
    await controller.share();
    settings = {
      serverUrl: "https://share.example.test/viewer",
      store: "gist",
      redactSecrets: false,
    };
    await controller.share();
    expect(dialogs.requests[0]).toMatchObject({
      message: expect.stringContaining("uploaded to https://my.omp.sh/s."),
    });
    expect(dialogs.requests[1]).toMatchObject({
      message: expect.stringContaining(
        "If that fails, it is uploaded to https://share.example.test/viewer instead",
      ),
    });
  });

  test("settings that cannot be read stop the share before any question is asked", async () => {
    const dialogs = new ScriptedDialogs([CONFIRMED]);
    const sharePort = new FakeSharePort(() => Promise.resolve(LINK));
    const controller = controllerFor({
      dialogs,
      sharePort,
      settings: () =>
        Promise.reject(
          new AppFailure({
            code: "unavailable",
            message: "The share settings could not be read, so nothing was shared.",
            retryable: true,
          }),
        ),
    });
    await expect(controller.share()).resolves.toEqual({
      outcome: "failed",
      error: {
        code: "unavailable",
        message: "The share settings could not be read, so nothing was shared.",
        retryable: true,
      },
    });
    expect(dialogs.requests).toEqual([]);
    expect(sharePort.threads).toEqual([]);
  });

  test("a failed upload keeps omp's own words and offers no link", async () => {
    const dialogs = new ScriptedDialogs([CONFIRMED]);
    const controller = controllerFor({
      dialogs,
      sharePort: new FakeSharePort(() =>
        Promise.reject(
          new AppFailure({
            code: "unavailable",
            message: "omp could not share this chat. Try again in a moment.",
            retryable: true,
          }),
        ),
      ),
    });
    await expect(controller.share()).resolves.toEqual({
      outcome: "failed",
      error: {
        code: "unavailable",
        message: "omp could not share this chat. Try again in a moment.",
        retryable: true,
      },
    });
    expect(dialogs.requests).toHaveLength(1);
  });

  test("an error that is not an AppFailure is reported as unexpected, never as a link", async () => {
    const controller = controllerFor({
      dialogs: new ScriptedDialogs([CONFIRMED]),
      sharePort: new FakeSharePort(() => Promise.reject(new Error("socket closed"))),
    });
    await expect(controller.share()).resolves.toEqual({
      outcome: "failed",
      error: {
        code: "internal",
        message: "Sharing did not finish for an unexpected reason.",
        retryable: false,
      },
    });
  });

  test("closing the link without copying leaves it not copied", async () => {
    const clipboard = new FakeClipboard(false);
    const outcome = await controllerFor({
      dialogs: new ScriptedDialogs([CONFIRMED, CLOSE]),
      sharePort: new FakeSharePort(() => Promise.resolve(LINK)),
      clipboard,
    }).share();
    expect(outcome).toEqual({ outcome: "link-not-copied", result: LINK });
    expect(clipboard.written).toEqual([]);
  });

  test("a refused clipboard shows the link to copy by hand, and never reports a copy", async () => {
    const dialogs = new ScriptedDialogs([CONFIRMED, COPY, SAVED]);
    const outcome = await controllerFor({
      dialogs,
      sharePort: new FakeSharePort(() => Promise.resolve(LINK)),
      clipboard: new FakeClipboard(true),
    }).share();
    expect(outcome).toEqual({ outcome: "shown-for-manual-copy", result: LINK });
    expect(dialogs.requests[2]).toMatchObject({
      kind: "editor",
      title: "Copy this link by hand",
      prefill: LINK.url,
      readOnly: true,
    });
  });

  test("the link note names the gist and the trimming note when omp reports them", async () => {
    const trimmed: ShareResult = {
      url: LINK.url,
      gistUrl: "https://gist.github.com/example/0123456789abcdef",
      truncated: true,
    };
    const dialogs = new ScriptedDialogs([CONFIRMED, CLOSE]);
    await controllerFor({
      dialogs,
      sharePort: new FakeSharePort(() => Promise.resolve(trimmed)),
    }).share();
    expect(dialogs.requests[1]).toMatchObject({
      optionDetails: [
        {
          description: `${trimmed.url} Secret GitHub gist: ${trimmed.gistUrl} omp trimmed large content to fit the share size limit.`,
        },
        { description: "The link is not copied. Share again to make a new link." },
      ],
    });
  });

  test("the upload starts only after the person confirms", async () => {
    let uploading = 0;
    const denied = controllerFor({
      dialogs: new ScriptedDialogs([DENIED]),
      sharePort: new FakeSharePort(() => Promise.resolve(LINK)),
      onUploading: () => {
        uploading += 1;
      },
    });
    await denied.share();
    expect(uploading).toBe(0);

    const confirmed = controllerFor({
      dialogs: new ScriptedDialogs([CONFIRMED, CLOSE]),
      sharePort: new FakeSharePort(() => Promise.resolve(LINK)),
      onUploading: () => {
        uploading += 1;
      },
    });
    await confirmed.share();
    expect(uploading).toBe(1);
  });

  test("a call made while a share runs returns that share, with one question", async () => {
    const dialogs = new ScriptedDialogs([CONFIRMED, CLOSE]);
    const sharePort = new FakeSharePort(() => Promise.resolve(LINK));
    const controller = controllerFor({ dialogs, sharePort });
    const first = controller.share();
    const second = controller.share();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ outcome: "link-not-copied", result: LINK });
    expect(dialogs.requests).toHaveLength(2);
    expect(sharePort.threads).toHaveLength(1);
  });

  test("once a share has ended, the next call asks again", async () => {
    const dialogs = new ScriptedDialogs([DENIED, DENIED]);
    const controller = controllerFor({
      dialogs,
      sharePort: new FakeSharePort(() => Promise.resolve(LINK)),
    });
    await controller.share();
    await controller.share();
    expect(dialogs.requests).toHaveLength(2);
  });
});
