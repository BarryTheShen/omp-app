import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  ConfigStore,
  type FolderPath,
  OmpCommandGateway,
  ThreadId,
} from "@omp-app/contracts";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { D4_SHARE_COMMAND, D4_SHARE_DESCRIPTORS } from "@/modules/D4/share/descriptors";
import type {
  DialogHost,
  DialogHostOpenOptions,
  DialogRequest,
  DialogResult,
  DialogResultFor,
} from "@/modules/U4/contract";
import {
  MemoryPreferenceStore,
  type ShortcutRegistry,
  ShortcutRegistryProvider,
  useShortcutRegistry,
} from "@/shortcuts";
import { type ShareFromChatOptions, useShareFromChat } from "./use-share-from-chat";

afterEach(() => cleanup());

const threadId = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");
const LINK = { url: "https://my.omp.sh/s/abc1234567#key", truncated: false };
const VALUES: Record<string, unknown> = {
  "share.serverUrl": "https://my.omp.sh/s",
  "share.store": "blob",
  "share.redactSecrets": true,
};
const CONFIRMED: DialogResult = {
  outcome: "answered",
  response: { kind: "confirm", confirmed: true },
};
const DENIED: DialogResult = {
  outcome: "answered",
  response: { kind: "confirm", confirmed: false },
};
const COPY: DialogResult = {
  outcome: "answered",
  response: { kind: "select", value: "Copy the link" },
};

/** Answers each question in turn, as U4's DialogHost would, and keeps what was asked. */
class ScriptedDialogs implements DialogHost {
  readonly requests: DialogRequest[] = [];
  private readonly answers: DialogResult[];

  constructor(answers: readonly DialogResult[]) {
    this.answers = [...answers];
  }

  open<R extends DialogRequest>(
    request: R,
    _options: DialogHostOpenOptions,
  ): Promise<DialogResultFor<R>> {
    this.requests.push(request);
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

/**
 * A client that serves the three share settings and a gateway whose `share` answers `share`. It is cast at the
 * client boundary only: the hook uses two ports, and the fake answers exactly those.
 */
function fakeClient(share: () => Promise<unknown>): AppClient {
  const config = {
    read: async ({ key, folder }: { key: string; folder: FolderPath | null }) => ({
      key,
      folder,
      secret: false,
      value: VALUES[key],
      source: "global",
      overrides: [],
    }),
  };
  const gateway = { share: vi.fn(share) };
  const port = (target: unknown) => {
    if (target === ConfigStore) return config;
    if (target === OmpCommandGateway) return gateway;
    throw new Error("The share hook asked for a port the test does not serve.");
  };
  return { port } as unknown as AppClient;
}

type Options = Omit<ShareFromChatOptions, "showStatus" | "showError" | "threadId">;

/** A component that mounts the hook and exposes the palette registry, as the palette and shortcuts see it. */
function Harness({
  options,
  registry,
  statuses,
  errors,
}: {
  readonly options: Options;
  readonly registry: { current?: ShortcutRegistry };
  readonly statuses: Array<string | null>;
  readonly errors: Array<string | null>;
}) {
  registry.current = useShortcutRegistry();
  useShareFromChat({
    ...options,
    threadId,
    showStatus: (text) => statuses.push(text),
    showError: (text) => errors.push(text),
  });
  return <textarea aria-label="Message input" />;
}

function mountShare(options: Options) {
  const registry: { current?: ShortcutRegistry } = {};
  const statuses: Array<string | null> = [];
  const errors: Array<string | null> = [];
  const view = render(
    <ShortcutRegistryProvider
      descriptors={D4_SHARE_DESCRIPTORS}
      preferenceStore={new MemoryPreferenceStore()}
    >
      <Harness options={options} registry={registry} statuses={statuses} errors={errors} />
    </ShortcutRegistryProvider>,
  );
  return { registry, statuses, errors, view };
}

function recordingClipboard() {
  return { writeText: vi.fn(async () => undefined) };
}

describe("useShareFromChat", () => {
  test("registers the palette command, which asks first and names where the chat goes", async () => {
    const dialogs = new ScriptedDialogs([DENIED]);
    const share = vi.fn(async () => LINK);
    const client = fakeClient(share);
    const { registry, statuses } = mountShare({
      client,
      folder: null,
      dialogs,
      clipboard: recordingClipboard(),
    });
    await waitFor(() => expect(registry.current?.commandFor(D4_SHARE_COMMAND.id)).toBeDefined());
    registry.current?.commandFor(D4_SHARE_COMMAND.id)?.run();
    await waitFor(() => expect(statuses.at(-1)).toBe("Nothing was shared."));
    expect(dialogs.requests[0]).toMatchObject({
      kind: "confirm",
      title: "Share this chat as a link?",
      message: expect.stringContaining("It is encrypted and uploaded to https://my.omp.sh/s."),
    });
    expect(share).not.toHaveBeenCalled();
  });

  test("after Confirm, uploads once, copies the link, and returns focus to the composer", async () => {
    const dialogs = new ScriptedDialogs([CONFIRMED, COPY]);
    const clipboard = recordingClipboard();
    const share = vi.fn(async () => LINK);
    const { registry, statuses, errors, view } = mountShare({
      client: fakeClient(share),
      folder: null,
      dialogs,
      clipboard,
    });
    await waitFor(() => expect(registry.current?.commandFor(D4_SHARE_COMMAND.id)).toBeDefined());
    await registry.current?.commandFor(D4_SHARE_COMMAND.id)?.run();

    await waitFor(() =>
      expect(statuses.at(-1)).toBe("Share link copied. Anyone with the link can read this chat."),
    );
    expect(clipboard.writeText).toHaveBeenCalledWith(LINK.url);
    expect(errors.at(-1)).toBeNull();
    const textarea = view.container.querySelector("textarea");
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  test("a failed share shows omp's own words in the error line, and no status", async () => {
    const dialogs = new ScriptedDialogs([CONFIRMED]);
    const { registry, statuses, errors } = mountShare({
      client: fakeClient(async () => {
        throw new AppFailure({
          code: "unavailable",
          message: "omp could not share this chat. Try again in a moment.",
          retryable: true,
        });
      }),
      folder: null,
      dialogs,
      clipboard: recordingClipboard(),
    });
    await waitFor(() => expect(registry.current?.commandFor(D4_SHARE_COMMAND.id)).toBeDefined());
    await registry.current?.commandFor(D4_SHARE_COMMAND.id)?.run();

    await waitFor(() =>
      expect(errors.at(-1)).toBe("omp could not share this chat. Try again in a moment."),
    );
    expect(statuses.at(-1)).toBeNull();
  });
});
