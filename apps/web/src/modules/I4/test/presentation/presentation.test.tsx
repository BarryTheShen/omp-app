import {
  AppFailure,
  type ConfigChanged,
  type ConfigEntry,
  type ConfigWriteArgs,
  type ConfigWriteResult,
  type FolderPath,
  type JsonValue,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsRuntime } from "../../../S1/runtime";
import type {
  ConfigChangeSource,
  ConfigSnapshot,
  ConfigStoreClient,
} from "../../../S1/settings-kit";
import type { CollaborationGuestPrompt } from "../../contract";
import { STREAM_SETTINGS_SECTION } from "../../settings/stream-descriptor";
import { StreamSettings } from "../../settings/stream-settings";
import { GuestPromptRow } from "../../transcript/guest-prompt-row";
import { ReadOnlyTranscriptRow } from "../../transcript/read-only-row";

const activeRuntimes: SettingsRuntime[] = [];
afterEach(() => {
  cleanup();
  for (const runtime of activeRuntimes.splice(0)) runtime.dispose();
});

const prompt: CollaborationGuestPrompt = {
  sessionId: "shared-1",
  participantId: "guest-1",
  messageId: "message-1",
  text: "Please inspect the build output.",
  timestamp: 1_759_600_000_000,
};
const config: ConfigSnapshot = {
  folder: null,
  revision: "stream-test",
  entries: [
    {
      secret: false,
      key: "stream.serverUrl",
      value: "https://stream.example/",
      source: "global",
      overrides: [],
    },
    {
      secret: false,
      key: "stream.redactPatterns",
      value: ["sk-[a-z0-9]{20,40}"],
      source: "global",
      overrides: [],
    },
  ],
};
type RealStreamState = {
  revision: string;
  entries: ConfigEntry[];
  writes: ConfigWriteArgs[];
  failListOnce: boolean;
  failWriteOnce: boolean;
  listeners: Set<(change: ConfigChanged) => void>;
};

function realStreamRuntime(
  options: { readonly failListOnce?: boolean; readonly failWriteOnce?: boolean } = {},
) {
  const state: RealStreamState = {
    revision: "revision-1",
    entries: config.entries.map((entry) => ({ ...entry })),
    writes: [],
    failListOnce: options.failListOnce === true,
    failWriteOnce: options.failWriteOnce === true,
    listeners: new Set(),
  };
  const client: ConfigStoreClient = {
    read: async ({ key }) => {
      const entry = state.entries.find((candidate) => candidate.key === key);
      if (!entry)
        throw new AppFailure({ code: "not_found", message: "Setting missing", retryable: false });
      return entry;
    },
    list: async () => {
      if (state.failListOnce) {
        state.failListOnce = false;
        throw new AppFailure({
          code: "internal",
          message: "Temporary settings read failure",
          retryable: true,
        });
      }
      return { entries: [...state.entries], revision: state.revision };
    },
    write: async (args): Promise<ConfigWriteResult> => {
      state.writes.push(args as ConfigWriteArgs);
      if (state.failWriteOnce) {
        state.failWriteOnce = false;
        throw new AppFailure({
          code: "internal",
          message: "Temporary settings save failure",
          retryable: true,
        });
      }
      const entry: ConfigEntry = args.value.secret
        ? {
            key: args.key,
            secret: true,
            isSet: args.value.action === "set",
            source: args.layer,
            overrides: [],
          }
        : {
            key: args.key,
            secret: false,
            value: args.value.value as JsonValue,
            source: args.layer,
            overrides: [],
          };
      const index = state.entries.findIndex((candidate) => candidate.key === args.key);
      if (index < 0) state.entries.push(entry);
      else state.entries[index] = entry;
      state.revision = `revision-${state.writes.length + 1}`;
      return {
        key: args.key,
        layer: args.layer,
        folder: args.folder as FolderPath | null,
        revision: state.revision,
        previousRevision: args.expectedRevision,
        entry,
      };
    },
  };
  const changes: ConfigChangeSource = {
    subscribe: (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  };
  const runtime = new SettingsRuntime(client, changes, {
    descriptor: STREAM_SETTINGS_SECTION,
    folder: null,
    layer: "global",
  });
  activeRuntimes.push(runtime);
  return { runtime, state };
}

describe("I4.4 shared transcript and Stream presentation", () => {
  test("attributes a guest prompt and gives its timestamp date and time", () => {
    render(<GuestPromptRow authorName="Morgan" prompt={prompt} />);
    const article = screen.getByRole("article", { name: "Guest prompt from Morgan" });
    expect(article.textContent).toContain("Morgan");
    expect(article.textContent).toContain("Please inspect the build output.");
    expect(screen.getByText("Read-only")).toBeTruthy();
    const time = article.querySelector("time");
    expect(time?.dateTime).toBe(new Date(prompt.timestamp).toISOString());
    expect(time?.textContent).toContain("2025");
  });

  test("shows a safe timestamp fallback when a finite timestamp is outside the Date range", () => {
    const { container } = render(
      <GuestPromptRow
        authorName="Morgan"
        prompt={{ ...prompt, timestamp: Number.MAX_SAFE_INTEGER }}
      />,
    );
    const time = container.querySelector("time");
    expect(time?.textContent).toBe("Time unavailable");
    expect(time?.getAttribute("datetime")).toBeNull();
  });

  test("makes read-only transcript descendants inert", () => {
    const { container } = render(
      <ReadOnlyTranscriptRow>
        <p>Shared answer</p>
        <button type="button">Change shared answer</button>
      </ReadOnlyTranscriptRow>,
    );
    const article = container.querySelector('[data-slot="i4-read-only-row"]');
    expect(article?.textContent).toContain("Shared answer");
    expect(article?.hasAttribute("inert")).toBe(true);
  });
  test("validates an https stream URL and string regular-expression values", () => {
    const server = STREAM_SETTINGS_SECTION.controls[0];
    const patterns = STREAM_SETTINGS_SECTION.controls[1];
    expect(
      server?.validate({ secret: false, value: "https://stream.example:8443/" }, config),
    ).toEqual({
      valid: true,
    });
    expect(server?.validate({ secret: false, value: "http://stream.example/" }, config).valid).toBe(
      false,
    );
    expect(
      server?.validate({ secret: false, value: "https://stream.example/path" }, config).valid,
    ).toBe(false);
    expect(patterns?.validate({ secret: false, value: ["sk-[a-z0-9]{20,40}"] }, config)).toEqual({
      valid: true,
    });
    expect(patterns?.validate({ secret: false, value: [{ pattern: "sk-.*" }] }, config).valid).toBe(
      false,
    );
    expect(patterns?.validate({ secret: false, value: ["["] }, config).valid).toBe(false);
  });

  test("real SettingsRuntime derives restart-required from the Stream URL descriptor", async () => {
    const { runtime, state } = realStreamRuntime();
    render(<StreamSettings runtime={runtime} />);
    fireEvent.change(await screen.findByLabelText("Stream Server"), {
      target: { value: "https://new.example/" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    expect(await screen.findByText("Restart required")).toBeTruthy();
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]?.key).toBe("stream.serverUrl");
  });

  test("real SettingsRuntime derives Applied from live redaction patterns", async () => {
    const { runtime, state } = realStreamRuntime();
    render(<StreamSettings runtime={runtime} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add pattern" }));
    fireEvent.change(screen.getByLabelText("Extra Redaction Patterns: Regular expression 2"), {
      target: { value: "ghp_[A-Za-z0-9]+" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    expect(await screen.findByText("Applied")).toBeTruthy();
    expect(state.writes[0]?.value).toEqual({
      secret: false,
      value: ["sk-[a-z0-9]{20,40}", "ghp_[A-Za-z0-9]+"],
    });
  });

  test("real SettingsRuntime keeps Restart required when both keys are saved", async () => {
    const { runtime } = realStreamRuntime();
    render(<StreamSettings runtime={runtime} />);
    fireEvent.change(await screen.findByLabelText("Stream Server"), {
      target: { value: "https://new.example/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add pattern" }));
    fireEvent.change(screen.getByLabelText("Extra Redaction Patterns: Regular expression 2"), {
      target: { value: "ghp_[A-Za-z0-9]+" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    expect(await screen.findByText("Restart required")).toBeTruthy();
  });

  test("catches a real runtime mount read rejection without an unhandled rejection", async () => {
    const { runtime } = realStreamRuntime({ failListOnce: true });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      render(<StreamSettings runtime={runtime} />);
      expect(await screen.findByText("Temporary settings read failure")).toBeTruthy();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("hides a saved apply status when a real runtime conflict opens", async () => {
    const { runtime, state } = realStreamRuntime();
    render(<StreamSettings runtime={runtime} />);
    fireEvent.change(await screen.findByLabelText("Stream Server"), {
      target: { value: "https://new.example/" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    expect(await screen.findByText("Restart required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add pattern" }));
    fireEvent.change(screen.getByLabelText("Extra Redaction Patterns: Regular expression 2"), {
      target: { value: "changed-pattern" },
    });
    const remoteEntry = state.entries.find((entry) => entry.key === "stream.redactPatterns");
    if (!remoteEntry || remoteEntry.secret) throw new Error("missing redaction entry");
    state.entries = state.entries.map((entry) =>
      entry.key === remoteEntry.key ? { ...entry, value: ["remote-pattern"] } : entry,
    );
    state.revision = "revision-remote";
    const change: ConfigChanged = {
      key: remoteEntry.key,
      layer: "global",
      folder: null,
      revision: state.revision,
      entry: { ...remoteEntry, value: ["remote-pattern"] },
    };
    for (const listener of state.listeners) listener(change);
    expect(await screen.findByText("Settings changed elsewhere")).toBeTruthy();
    expect((screen.getByLabelText("Stream Server") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText("Restart required")).toBeNull();
  });

  test("Try again re-reads a failed mount read and shows the settings", async () => {
    const { runtime } = realStreamRuntime({ failListOnce: true });
    render(<StreamSettings runtime={runtime} />);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(await screen.findByText("Temporary settings read failure")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Stream Server")).toBeTruthy();
    expect(screen.queryByText("Temporary settings read failure")).toBeNull();
  });

  test("keeps a real runtime failed save visible without a retry button", async () => {
    const { runtime } = realStreamRuntime({ failWriteOnce: true });
    render(<StreamSettings runtime={runtime} />);
    fireEvent.change(await screen.findByLabelText("Stream Server"), {
      target: { value: "https://new.example/" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    expect(await screen.findByText("Temporary settings save failure")).toBeTruthy();
    expect(screen.getByText("Not saved: Stream Server.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /try again|retry/i })).toBeNull();
  });
});
