import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { AppFailure, type CapabilityMap, ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createSlashCommandProvider,
  type SlashCommandProvider,
  type SlashRoute,
} from "@/modules/D2/slash";
import { completedRun, fakeSlashClient } from "@/modules/D2/slash/test-support";
import type { SessionLifecycleController } from "@/modules/D5/lifecycle";
import { ComposerSurface } from "@/modules/U2/composer/composer";
import type { PromptIntent } from "@/modules/U2/contract";
import { ComposerTriggers } from "./composer-triggers";
import {
  freshSlashCommand,
  newChatSlashCommand,
  routeSubmit,
  runSlashRoute,
} from "./slash-commands";

function RuntimeHarness({ children }: { readonly children: ReactNode }) {
  const runtime = useExternalStoreRuntime({
    messages: [] as readonly ThreadMessage[],
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

afterEach(() => cleanup());

const threadId = ThreadId.parse("thread-d23-composition");
const available: CapabilityMap = {
  "omp.cmd.get_available_commands": { state: "available", via: "rpc" },
};
const prompt: PromptIntent = { mode: "prompt", text: "/usage", delivery: "new" };

describe("D2.3 submit routing in the app", () => {
  test("only a plain prompt with nothing attached is checked for a command", async () => {
    const route = vi.fn(async () => ({ kind: "omp" as const, command: "/usage" }));
    const provider = { route } as unknown as SlashCommandProvider;

    await expect(routeSubmit({ intent: prompt, hasAttachments: false, provider })).resolves.toEqual(
      { kind: "omp", command: "/usage" },
    );
    await expect(
      routeSubmit({ intent: { ...prompt, mode: "bash" }, hasAttachments: false, provider }),
    ).resolves.toBeNull();
    await expect(
      routeSubmit({ intent: { ...prompt, mode: "python" }, hasAttachments: false, provider }),
    ).resolves.toBeNull();
    await expect(
      routeSubmit({ intent: prompt, hasAttachments: true, provider }),
    ).resolves.toBeNull();
    await expect(
      routeSubmit({ intent: prompt, hasAttachments: false, provider: null }),
    ).resolves.toBeNull();
    expect(route).toHaveBeenCalledTimes(1);
  });
});

describe("D2.3 /new", () => {
  test("starts a chat through the lifecycle and opens it, with a plain note", async () => {
    const opened: string[] = [];
    const lifecycle = {
      newSession: vi.fn(async () => ({
        status: "completed" as const,
        value: ThreadId.parse("thread-next"),
      })),
    } as unknown as SessionLifecycleController;
    const command = newChatSlashCommand({
      lifecycle,
      openThread: async (threadId) => {
        opened.push(threadId);
      },
    });

    await expect(command.run({})).resolves.toEqual({ message: "Started a new chat." });
    expect(opened).toEqual(["thread-next"]);
  });

  test("without a folder it says why it cannot start, and opens nothing", async () => {
    const command = newChatSlashCommand({ lifecycle: null, openThread: async () => undefined });
    await expect(command.run({})).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message: "Starting a new chat requires a selected workspace folder.",
      },
    });
  });

  test("a refused new chat carries omp's reason, and a cancelled one changes nothing", async () => {
    const refused = {
      newSession: async () => ({
        status: "error" as const,
        error: {
          code: "unavailable" as const,
          message: "Starting a new session is unavailable for this connection.",
          retryable: false,
        },
      }),
    } as unknown as SessionLifecycleController;
    const refusedCommand = newChatSlashCommand({
      lifecycle: refused,
      openThread: async () => undefined,
    });
    await expect(refusedCommand.run({})).rejects.toBeInstanceOf(AppFailure);
    await expect(refusedCommand.run({})).rejects.toMatchObject({
      appError: { message: "Starting a new session is unavailable for this connection." },
    });

    const cancelled = {
      newSession: async () => ({ status: "cancelled" as const }),
    } as unknown as SessionLifecycleController;
    const cancelledCommand = newChatSlashCommand({
      lifecycle: cancelled,
      openThread: async () => undefined,
    });
    await expect(cancelledCommand.run({})).resolves.toEqual({});
  });
});

describe("D2.3 /fresh", () => {
  test("without a session it says why it cannot run", async () => {
    await expect(freshSlashCommand({ lifecycle: null }).run({})).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message: "Refreshing the model connection is unavailable for this session.",
      },
    });
  });

  test("a declined confirmation runs nothing and shows nothing", async () => {
    const fresh = vi.fn(async () => ({ status: "cancelled" as const }));
    const lifecycle = { fresh } as unknown as SessionLifecycleController;
    await expect(freshSlashCommand({ lifecycle }).run({})).resolves.toEqual({});
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  test("a finished refresh shows omp's own words, with the layout flattened to one line", async () => {
    const lifecycle = {
      fresh: async () => ({
        status: "completed" as const,
        value: completedRun("/fresh", "Connection\nrefreshed."),
      }),
    } as unknown as SessionLifecycleController;
    await expect(freshSlashCommand({ lifecycle }).run({})).resolves.toEqual({
      message: "omp: Connection refreshed.",
    });
  });

  test("a refresh omp printed nothing for says so in plain words", async () => {
    const lifecycle = {
      fresh: async () => ({ status: "completed" as const, value: completedRun("/fresh", "") }),
    } as unknown as SessionLifecycleController;
    await expect(freshSlashCommand({ lifecycle }).run({})).resolves.toEqual({
      message: "omp had nothing to say about it.",
    });
  });

  test("a refused refresh carries its reason as the failure", async () => {
    const lifecycle = {
      fresh: async () => ({
        status: "error" as const,
        error: {
          code: "conflict" as const,
          message: "You switched sessions before the connection could be refreshed.",
          retryable: true,
        },
      }),
    } as unknown as SessionLifecycleController;
    await expect(freshSlashCommand({ lifecycle }).run({})).rejects.toMatchObject({
      appError: { message: "You switched sessions before the connection could be refreshed." },
    });
  });
});

describe("D2.3 reporting a routed command", () => {
  test("a finished omp command shows omp's words in the header, after the old note is cleared", async () => {
    const shown: Array<string | null> = [];
    const provider = {
      execute: vi.fn(async () => completedRun("/usage", "Usage\nTotal tokens: 0")),
    } as unknown as SlashCommandProvider;
    const route: SlashRoute = { kind: "omp", command: "/usage" };

    await runSlashRoute({
      route,
      intent: prompt,
      provider,
      showStatus: (text) => shown.push(text),
    });

    expect(shown).toEqual([null, "omp: Usage Total tokens: 0"]);
  });

  test("an aborted marker on a finished command still shows its words, since omp sets it on an idle command that finished", async () => {
    const shown: Array<string | null> = [];
    const provider = {
      execute: async () => ({
        ...completedRun("/usage", "Total tokens: 0"),
        status: "aborted" as const,
      }),
    } as unknown as SlashCommandProvider;
    const route: SlashRoute = { kind: "omp", command: "/usage" };

    await runSlashRoute({
      route,
      intent: prompt,
      provider,
      showStatus: (text) => shown.push(text),
    });

    expect(shown).toEqual([null, "omp: Total tokens: 0"]);
  });

  test("the person's own cancellation fails the send, so the composer keeps the typed text", async () => {
    const provider = {
      execute: async () => {
        throw new AppFailure({
          code: "cancelled",
          message: "The command was cancelled.",
          retryable: false,
        });
      },
    } as unknown as SlashCommandProvider;
    const route: SlashRoute = { kind: "omp", command: "/usage" };

    await expect(
      runSlashRoute({ route, intent: prompt, provider, showStatus: () => undefined }),
    ).rejects.toMatchObject({
      appError: { code: "cancelled", message: "The command was cancelled." },
    });
  });

  test("the app's own command reports its note in the header", async () => {
    const shown: Array<string | null> = [];
    const route: SlashRoute = {
      kind: "app",
      command: {
        name: "new",
        description: "Start a new chat",
        run: async () => ({ message: "Started a new chat." }),
      },
    };

    await runSlashRoute({
      route,
      intent: { ...prompt, text: "/new" },
      provider: null,
      showStatus: (text) => shown.push(text),
    });

    expect(shown).toEqual([null, "Started a new chat."]);
  });
});

describe("D2.3 the list inside the composer's trigger root", () => {
  test("typing a command in the app's composer opens omp's list, and Enter inserts the command", async () => {
    const fake = fakeSlashClient();
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    render(
      <RuntimeHarness>
        <ComposerTriggers
          client={fake.client}
          folder={null}
          capabilities={available}
          slash={provider}
        >
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </ComposerTriggers>
      </RuntimeHarness>,
    );

    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/us" } });
    input.setSelectionRange(3, 3);
    await waitFor(() =>
      expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeTruthy(),
    );
    await waitFor(() => expect(screen.getByText("/usage")).toBeTruthy());
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toBe("/usage "));
    provider.dispose();
  });
});
