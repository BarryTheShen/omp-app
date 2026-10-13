import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import {
  AppFailure,
  type CapabilityMap,
  type RpcSessionSend,
  type SessionDeleteCommandResult,
  ThreadId,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createSlashCommandProvider,
  routeSlashText,
  type SlashAppCommand,
  type SlashCommandProvider,
  type SlashRoute,
} from "@/modules/D2/slash";
import { completedRun, fakeSlashClient } from "@/modules/D2/slash/test-support";
import type { SessionLifecycleController } from "@/modules/D5/lifecycle";
import type { SessionCatalogModel } from "@/modules/R1/catalog/catalog";
import type { SessionMetadata } from "@/modules/R1/contract";
import { ComposerSurface } from "@/modules/U2/composer/composer";
import type { PromptIntent } from "@/modules/U2/contract";
import type { OverlayOpenOptions } from "@/overlay/overlay-host";
import type { CommandReport } from "./command-report/command-report";
import { ComposerTriggers } from "./composer-triggers";
import {
  askFirstSlashCommand,
  askFirstSlashCommands,
  describeResetTarget,
  freshSlashCommand,
  guardOmpSend,
  hotkeysSlashCommand,
  loginSlashCommand,
  newChatSlashCommand,
  routeSubmit,
  runSlashRoute,
  sessionDeleteSlashCommand,
  settingsSlashCommand,
  shareSlashCommand,
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
  test("several lines of omp's words go to the report panel, every line kept, and the old header is cleared", async () => {
    const shown: Array<string | null> = [];
    const reports: CommandReport[] = [];
    const provider = {
      execute: vi.fn(async () => completedRun("/usage", "Usage\nTotal tokens: 0")),
    } as unknown as SlashCommandProvider;
    const route: SlashRoute = { kind: "omp", command: "/usage" };

    await runSlashRoute({
      route,
      intent: prompt,
      provider,
      showStatus: (text) => shown.push(text),
      showReport: (report) => reports.push(report),
    });

    expect(shown).toEqual([null]);
    expect(reports).toEqual([{ command: "/usage", text: "Usage\nTotal tokens: 0" }]);
  });

  test("every reply omp printed for one command is one report, one line each, in order", async () => {
    const reports: CommandReport[] = [];
    const provider = {
      execute: async () => ({
        ...completedRun("/compact"),
        outputs: [{ text: "Compacting…" }, { text: "Done." }],
      }),
    } as unknown as SlashCommandProvider;
    const route: SlashRoute = { kind: "omp", command: "/compact" };

    await runSlashRoute({
      route,
      intent: prompt,
      provider,
      showStatus: () => undefined,
      showReport: (report) => reports.push(report),
    });

    expect(reports).toEqual([{ command: "/compact", text: "Compacting…\nDone." }]);
  });

  test("one line of omp's words stays in the header, and no report opens", async () => {
    const shown: Array<string | null> = [];
    const reports: CommandReport[] = [];
    const provider = {
      execute: vi.fn(async () => completedRun("/usage", "Total tokens: 0")),
    } as unknown as SlashCommandProvider;
    const route: SlashRoute = { kind: "omp", command: "/usage" };

    await runSlashRoute({
      route,
      intent: prompt,
      provider,
      showStatus: (text) => shown.push(text),
      showReport: (report) => reports.push(report),
    });

    expect(shown).toEqual([null, "omp: Total tokens: 0"]);
    expect(reports).toEqual([]);
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
      showReport: () => undefined,
    });

    expect(shown).toEqual([null, "omp: Total tokens: 0"]);
  });

  test("a command that printed nothing says that it ran", async () => {
    const shown: Array<string | null> = [];
    const provider = {
      execute: vi.fn(async () => completedRun("/jobs", "")),
    } as unknown as SlashCommandProvider;
    const route: SlashRoute = { kind: "omp", command: "/jobs" };

    await runSlashRoute({
      route,
      intent: prompt,
      provider,
      showStatus: (text) => shown.push(text),
      showReport: () => undefined,
    });

    expect(shown).toEqual([null, "Ran /jobs."]);
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
      runSlashRoute({
        route,
        intent: prompt,
        provider,
        showStatus: () => undefined,
        showReport: () => undefined,
      }),
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
      showReport: () => undefined,
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
          notify={() => undefined}
          fail={() => undefined}
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

describe("/login", () => {
  test("typed alone it is an app command: the login page opens and the text never reaches omp", async () => {
    const openLogin = vi.fn();
    const command = loginSlashCommand({ openLogin });
    expect(routeSlashText("/login", [], [command])).toEqual({ kind: "app", command });
    await expect(command.run({})).resolves.toEqual({});
    expect(openLogin).toHaveBeenCalledTimes(1);
  });

  test("with words after it, it is not the app command", () => {
    const command = loginSlashCommand({ openLogin: () => undefined });
    expect(routeSlashText("/login anthropic", [], [command])).not.toMatchObject({ kind: "app" });
  });
});

describe("/settings and /hotkeys", () => {
  test("/settings typed alone is an app command that opens the app's Settings", async () => {
    const openSettings = vi.fn();
    const command = settingsSlashCommand({ openSettings });
    expect(routeSlashText("/settings", [], [command])).toEqual({ kind: "app", command });
    await expect(command.run({})).resolves.toEqual({});
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  test("/hotkeys typed alone is an app command that opens the shortcut sheet", async () => {
    const openShortcuts = vi.fn();
    const command = hotkeysSlashCommand({ openShortcuts });
    expect(routeSlashText("/hotkeys", [], [command])).toEqual({ kind: "app", command });
    await expect(command.run({})).resolves.toEqual({});
    expect(openShortcuts).toHaveBeenCalledTimes(1);
  });
});

describe("#957 /share never reaches omp unconfirmed", () => {
  test("every form of /share goes to the app, with or without attachments, and before the provider is ready", async () => {
    const route = vi.fn(async () => ({ kind: "omp" as const, command: "/share" }));
    const provider = { route } as unknown as SlashCommandProvider;
    const share = shareSlashCommand({ run: async () => ({ message: "Nothing was shared." }) });
    for (const text of ["/share", "/share now", " /SHARE"]) {
      for (const hasAttachments of [false, true]) {
        await expect(
          routeSubmit({
            intent: { ...prompt, text },
            hasAttachments,
            provider,
            appCommands: [share],
          }),
          `${JSON.stringify(text)} with attachments: ${hasAttachments}`,
        ).resolves.toEqual({ kind: "app", command: share });
      }
      await expect(
        routeSubmit({
          intent: { ...prompt, text },
          hasAttachments: false,
          provider: null,
          appCommands: [share],
        }),
      ).resolves.toEqual({ kind: "app", command: share });
    }
    expect(route).not.toHaveBeenCalled();
  });

  test("the share command runs the flow it is given, and shows the message that flow returns", async () => {
    const run = vi.fn(async () => ({ message: "Share link copied." }));
    const command = shareSlashCommand({ run });
    expect(command.name).toBe("share");
    expect(command.description).toBe("Share this chat as a link");
    await expect(command.run({})).resolves.toEqual({ message: "Share link copied." });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("a prompt, steer or follow-up in a form of /share never reaches omp, and other commands pass", async () => {
    const send = vi.fn(async () => undefined) as unknown as RpcSessionSend;
    const guarded = guardOmpSend(send);
    const sent = (type: string, message: string) =>
      guarded({ threadId, command: { type, message } } as unknown as Parameters<RpcSessionSend>[0]);
    for (const type of ["prompt", "steer", "follow_up"]) {
      await expect(sent(type, "/share extra")).rejects.toMatchObject({
        appError: { code: "unavailable", retryable: false },
      });
    }
    expect(send).not.toHaveBeenCalled();
    await sent("prompt", "pong");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("#1272 /session delete and /usage reset ask first, and only Confirm sends omp the command", () => {
  /**
   * A gateway that answers each command with omp's words for it, gives `/session delete` the reply it is told, and records
   * what it was sent.
   */
  function gatewayAnswering(
    text: string,
    reply: SessionDeleteCommandResult = { outcome: "unknown" },
  ) {
    return {
      run: vi.fn(async ({ command }: { readonly command: string }) => completedRun(command, text)),
      sessionDelete: vi.fn(async () => reply),
    };
  }

  test("Cancel sends nothing to omp, and the command shows nothing", async () => {
    const gateway = gatewayAnswering("unused");
    const command = sessionDeleteSlashCommand({
      confirm: async () => false,
      gateway,
      threadId,
      catalog: null,
      lifecycle: null,
      openThread: async () => undefined,
    });
    await expect(command.run({})).resolves.toEqual({});
    expect(gateway.sessionDelete).not.toHaveBeenCalled();
  });

  test("Confirm sends the typed command to omp once, and a refusal says why in the header", async () => {
    const confirm = vi.fn(async () => true);
    const gateway = gatewayAnswering("unused", { outcome: "refused", reason: "running" });
    const command = sessionDeleteSlashCommand({
      confirm,
      gateway,
      threadId,
      catalog: null,
      lifecycle: null,
      openThread: async () => undefined,
    });
    await expect(command.run({})).resolves.toEqual({
      message: "Wait for this chat's turn to finish, then delete it.",
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(gateway.sessionDelete).toHaveBeenCalledTimes(1);
    expect(gateway.sessionDelete).toHaveBeenCalledWith({ threadId }, {});
  });

  /** The chat the list holds, and the reply and new-chat result a delete is given, with the calls recorded in order. */
  const listedChat = {
    id: threadId,
    cwd: "/workspace",
    sessionFile: "/sessions/one.jsonl",
  } as unknown as SessionMetadata;
  const newThread = ThreadId.parse("thread-new-1351");

  function runDelete(
    reply: SessionDeleteCommandResult,
    sessions: readonly SessionMetadata[],
    newSession: unknown,
  ) {
    const order: string[] = [];
    const gateway = { run: vi.fn(), sessionDelete: vi.fn(async () => reply) };
    const lifecycle = {
      newSession: vi.fn(async () => {
        order.push("new chat");
        return newSession;
      }),
    };
    const openThread = vi.fn(async (opened: ThreadId) => {
      order.push(`open ${opened}`);
    });
    const reconcile = vi.fn(async () => {
      order.push("drop row");
    });
    const catalog = {
      getSnapshot: () => ({ sessions }),
      reconcile,
    } as unknown as SessionCatalogModel;
    const command = sessionDeleteSlashCommand({
      confirm: async () => true,
      gateway,
      threadId,
      catalog,
      lifecycle: lifecycle as unknown as SessionLifecycleController,
      openThread,
    });
    return { command, order, reconcile, openThread, lifecycle };
  }

  test("a deleted reply opens a new chat in place of the chat, then drops the chat's row, and shows no header note", async () => {
    const run = runDelete({ outcome: "deleted" }, [listedChat], {
      status: "completed",
      value: newThread,
    });
    await expect(run.command.run({})).resolves.toEqual({});
    expect(run.order).toEqual(["new chat", `open ${newThread}`, "drop row"]);
    expect(run.reconcile).toHaveBeenCalledWith({
      kind: "removed",
      folder: "/workspace",
      sessionFile: "/sessions/one.jsonl",
      id: threadId,
    });
  });

  test("a deleted chat's row still goes when no new chat opens, and the new chat's failure is what the person sees", async () => {
    const run = runDelete({ outcome: "deleted" }, [listedChat], {
      status: "error",
      error: { code: "unavailable", message: "Starting a new session failed.", retryable: false },
    });
    await expect(run.command.run({})).rejects.toMatchObject({
      appError: { message: "Starting a new session failed." },
    });
    expect(run.openThread).not.toHaveBeenCalled();
    expect(run.reconcile).toHaveBeenCalledTimes(1);
  });

  test("a refused delete leaves the chat and its row as they are, and the header says why", async () => {
    const run = runDelete({ outcome: "refused", reason: "open-elsewhere" }, [listedChat], {
      status: "completed",
      value: newThread,
    });
    await expect(run.command.run({})).resolves.toEqual({
      message: "Another tab or window has this chat open. Close it there, then delete it again.",
    });
    expect(run.lifecycle.newSession).not.toHaveBeenCalled();
    expect(run.openThread).not.toHaveBeenCalled();
    expect(run.reconcile).not.toHaveBeenCalled();
  });

  test.each([
    [
      { outcome: "refused", reason: "running" },
      "Wait for this chat's turn to finish, then delete it.",
    ],
    [
      { outcome: "refused", reason: "open-elsewhere" },
      "Another tab or window has this chat open. Close it there, then delete it again.",
    ],
    [
      { outcome: "refused", reason: "finishing" },
      "omp is still finishing this chat. Try again in a moment.",
    ],
    [
      { outcome: "refused", reason: "not-saved" },
      "This chat is not saved yet, so there is nothing to delete.",
    ],
    [{ outcome: "failed" }, "The chat was not deleted. Try again."],
    [{ outcome: "unknown" }, "omp did not delete the chat."],
  ] as const)(
    "a delete that deletes nothing (%j) says why in the header",
    async (reply, message) => {
      const run = runDelete(reply, [listedChat], { status: "completed", value: newThread });
      await expect(run.command.run({})).resolves.toEqual({ message });
      expect(run.openThread).not.toHaveBeenCalled();
      expect(run.reconcile).not.toHaveBeenCalled();
    },
  );

  test("a deleted chat the list does not hold has no row to drop, and the view still leaves it", async () => {
    const run = runDelete({ outcome: "deleted" }, [], {
      status: "completed",
      value: newThread,
    });
    await run.command.run({});
    expect(run.openThread).toHaveBeenCalledWith(newThread);
    expect(run.reconcile).not.toHaveBeenCalled();
  });

  test("a reply with several lines goes to the report, and the header shows no note", async () => {
    const reports: CommandReport[] = [];
    const command = askFirstSlashCommand({
      name: "usage reset",
      description: "Spend a saved rate-limit reset, after you confirm",
      takesArguments: true,
      confirm: async () => true,
      gateway: gatewayAnswering("Usage\nTotal tokens: 0"),
      threadId,
      showReport: (report) => reports.push(report),
    });
    await expect(command.run({ args: "codex/active" })).resolves.toEqual({});
    expect(reports).toEqual([
      { command: "/usage reset codex/active", text: "Usage\nTotal tokens: 0" },
    ]);
  });

  test("/usage reset hands its target to the question, and sends that target to omp", async () => {
    const confirm = vi.fn(async () => true);
    const gateway = gatewayAnswering("No provider accounts found. Use /login to add one.");
    const command = askFirstSlashCommand({
      name: "usage reset",
      description: "Spend a saved rate-limit reset, after you confirm",
      takesArguments: true,
      confirm,
      gateway,
      threadId,
      showReport: () => undefined,
    });
    await expect(command.run({ args: "codex/active" })).resolves.toEqual({
      message: "omp: No provider accounts found. Use /login to add one.",
    });
    expect(confirm).toHaveBeenCalledWith("codex/active");
    expect(gateway.run).toHaveBeenCalledWith(
      { threadId, command: "/usage reset codex/active" },
      {},
    );
  });

  test("a cancelled usage reset sends nothing to omp", async () => {
    const gateway = gatewayAnswering("unused");
    const command = askFirstSlashCommand({
      name: "usage reset",
      description: "Spend a saved rate-limit reset, after you confirm",
      takesArguments: true,
      confirm: async () => false,
      gateway,
      threadId,
      showReport: () => undefined,
    });
    await expect(command.run({ args: "anthropic/2" })).resolves.toEqual({});
    expect(gateway.run).not.toHaveBeenCalled();
  });

  test("a send that fails rejects with the same error, so the composer keeps the typed text", async () => {
    const failure = new AppFailure({
      code: "unavailable",
      message: "The connection dropped.",
      retryable: true,
    });
    const gateway = {
      run: vi.fn(),
      sessionDelete: vi.fn(async () => {
        throw failure;
      }),
    };
    const command = sessionDeleteSlashCommand({
      confirm: async () => true,
      gateway,
      threadId,
      catalog: null,
      lifecycle: null,
      openThread: async () => undefined,
    });
    await expect(command.run({})).rejects.toBe(failure);
  });

  test("the app answers exactly /session delete and /usage reset, and only usage reset takes a target", () => {
    const commands = askFirstSlashCommands({
      catalog: null,
      fallbackTitle: "Seeded chat 2",
      overlay: { open: () => undefined },
      gateway: gatewayAnswering("unused"),
      threadId,
      lifecycle: null,
      openThread: async () => undefined,
      showReport: () => undefined,
    });
    expect(commands.map((command) => [command.name, command.takesArguments])).toEqual([
      ["session delete", undefined],
      ["usage reset", true],
    ]);
  });

  /** Sends `/session delete` and renders the question it opens, the way the overlay would. */
  function askedDeleteQuestion(catalog: SessionCatalogModel | null, fallbackTitle: string) {
    const opened: OverlayOpenOptions[] = [];
    const gateway = gatewayAnswering("Session deleted.");
    const [sessionDelete] = askFirstSlashCommands({
      catalog,
      fallbackTitle,
      overlay: {
        open: (options) => {
          opened.push(options);
          return undefined;
        },
      },
      gateway,
      threadId,
      lifecycle: null,
      openThread: async () => undefined,
      showReport: () => undefined,
    });
    void sessionDelete?.run({});
    const content = opened[0]?.content;
    if (typeof content !== "function") throw new Error("The question has no render function.");
    render(
      content({
        id: "delete-chat",
        close: () => undefined,
        requestClose: () => undefined,
        update: () => undefined,
      }),
    );
    return { opened, gateway };
  }

  test("/session delete asks with the chat's name as the sidebar shows it, and sends nothing until Delete", () => {
    const listed = { id: threadId, firstPrompt: "ping" } as unknown as SessionMetadata;
    const catalog = {
      getSnapshot: () => ({ sessions: [listed] }),
    } as unknown as SessionCatalogModel;
    const { opened, gateway } = askedDeleteQuestion(catalog, "Conversation");
    expect(opened.map((options) => options.label)).toEqual(["Delete chat"]);
    expect(screen.getByText('Delete "ping"?')).toBeTruthy();
    expect(gateway.sessionDelete).not.toHaveBeenCalled();
  });

  test("until the sidebar's list holds the chat, the header's title names it", () => {
    const catalog = { getSnapshot: () => ({ sessions: [] }) } as unknown as SessionCatalogModel;
    askedDeleteQuestion(catalog, "Conversation");
    expect(screen.getByText('Delete "Conversation"?')).toBeTruthy();
  });

  test("a routed command that takes arguments gets the text after its words", async () => {
    const run = vi.fn(async () => ({}));
    const command: SlashAppCommand = {
      name: "usage reset",
      description: "",
      takesArguments: true,
      run,
    };
    await runSlashRoute({
      route: { kind: "app", command, args: "codex/active" },
      intent: { ...prompt, text: "/usage reset codex/active" },
      provider: null,
      showStatus: vi.fn(),
      showReport: () => undefined,
    });
    expect(run).toHaveBeenCalledWith({ args: "codex/active" });
  });
});

describe("#1272 the account a reset names, in plain words", () => {
  test("the active account and a numbered account are named by their provider", () => {
    expect(describeResetTarget("codex/active")).toBe("Codex, the active account");
    expect(describeResetTarget("openai-codex/active")).toBe("Codex, the active account");
    expect(describeResetTarget("Claude/2")).toBe("Claude account 2");
    expect(describeResetTarget("anthropic/ 3 ")).toBe("Claude account 3");
  });

  test("a target it cannot read is shown as typed, and omp then says what it does", () => {
    expect(describeResetTarget("nope/active")).toBe('the account "nope/active"');
    expect(describeResetTarget("codex/")).toBe('the account "codex/"');
    expect(describeResetTarget("codex/work")).toBe('the account "codex/work"');
    expect(describeResetTarget("active")).toBe('the account "active"');
  });
});

describe("#1271 a typed terminal-only command is refused in the composer, and omp runs nothing", () => {
  test("/clear is not a plain prompt: the send is answered by the app, refused, and no omp command runs", async () => {
    const fake = fakeSlashClient();
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    const intent: PromptIntent = { mode: "prompt", text: "/clear", delivery: "new" };
    const route = await routeSubmit({ intent, hasAttachments: false, provider });
    // A null route is a plain prompt, which the composer sends to the model. This one must not reach that path.
    if (route === null) throw new Error("/clear would be sent to the model");
    await expect(
      runSlashRoute({ route, intent, provider, showStatus: vi.fn(), showReport: vi.fn() }),
    ).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message: "/clear only runs in omp's terminal, so nothing was sent. Use New chat instead.",
      },
    });
    expect(fake.runs).toEqual([]);
    provider.dispose();
  });
});
