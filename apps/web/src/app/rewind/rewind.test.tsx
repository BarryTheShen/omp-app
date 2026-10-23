import type {
  CapabilityMap,
  DescriptorId,
  EntryId,
  RpcSessionSend,
  SessionEntryHead,
  ThreadId,
} from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type HistoryPanel, treeSlashCommand } from "@/app/slash-commands";
import { LayoutArea, type SurfaceMap } from "@/layout";
import type { TreeNode } from "@/modules/P4/contract";
import { P4_DESCRIPTORS } from "@/modules/P4/contract";
import { OmpRuntimeStore } from "@/modules/R0/store";
import { OverlayHost } from "@/overlay";
import {
  MemoryPreferenceStore,
  type ShortcutRegistry,
  ShortcutRegistryProvider,
  useShortcutRegistry,
} from "@/shortcuts";
import { isUserMessage, REWIND_CAPABILITIES, rewindAvailable, treeEntry } from "./rewind-tree";
import {
  type ConversationTransitionOptions,
  useConversationTransitions,
} from "./use-conversation-transitions";
import { useRewindPanel } from "./use-rewind-panel";

afterEach(cleanup);

const threadId = "rewind-thread" as ThreadId;
const otherThread = "other-thread" as ThreadId;
const REWIND_COMMAND = "P4.treeCommand" as DescriptorId;

function message(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: string,
  minute: number,
): SessionEntryHead {
  return {
    type: "message",
    id: id as EntryId,
    parentId: parentId === null ? null : (parentId as EntryId),
    timestamp: `2026-10-07T10:${String(minute).padStart(2, "0")}:00.000Z`,
    message: { role, content },
  };
}

// Two exchanges, the second one ending the conversation: the leaf is the last assistant reply.
const TREE: readonly TreeNode[] = [
  {
    entry: message("e-1", null, "user", "Plan the release.", 1),
    children: [
      {
        entry: message("e-2", "e-1", "assistant", "Ship on Friday.", 2),
        children: [
          {
            entry: message("e-3", "e-2", "user", "Run the tests first.", 3),
            children: [
              {
                entry: message("e-4", "e-3", "assistant", "All tests pass.", 4),
                children: [],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    entry: {
      type: "branch_summary",
      id: "e-summary" as EntryId,
      parentId: null,
      timestamp: "2026-10-07T10:05:00.000Z",
      summary: "Saved summary",
    },
    children: [],
  },
];

const AVAILABLE: CapabilityMap = {
  "omp.cmd.get_tree": { state: "available", via: "rpc" },
  "omp.cmd.branch": { state: "available", via: "rpc" },
  "omp.cmd.fork": { state: "available", via: "rpc" },
};

/** A fake omp: the tree, branch and fork commands, and the new session's identity. */
function fakeOmp(calls: string[], failFork = false): RpcSessionSend {
  const answer = async (args: { command: { type: string; entryId?: string } }) => {
    const { command } = args;
    calls.push(`${command.type}${command.entryId ? ` ${command.entryId}` : ""}`);
    if (command.type === "get_tree") return { tree: TREE, leafId: "e-4" };
    if (command.type === "branch") return { text: "", cancelled: false };
    if (command.type === "fork") {
      if (failFork) throw new Error("internal");
      return { text: "", cancelled: false };
    }
    if (command.type === "get_state") return { sessionId: "branched-thread" };
    throw new Error(`The fake omp does not answer ${command.type}.`);
  };
  return answer as unknown as RpcSessionSend;
}

function heldOmp(gate: Promise<void>): RpcSessionSend {
  const base = fakeOmp([]);
  return (async (args: unknown) => {
    const request = args as { command: { type: string } };
    if (request.command.type === "get_tree") await gate;
    return base(args as never);
  }) as unknown as RpcSessionSend;
}

interface HarnessProps {
  readonly currentThread: ThreadId;
  readonly send: RpcSessionSend;
  readonly switchThread: ConversationTransitionOptions["switchThread"];
  readonly capabilities: CapabilityMap;
  readonly holder: { registry?: ShortcutRegistry };
}

function RegistryProbe({ holder }: { readonly holder: { registry?: ShortcutRegistry } }) {
  holder.registry = useShortcutRegistry();
  return null;
}

/** The app's panels area with the todo panel and the rewind panel, as the thread view mounts them. */
function Harness({ currentThread, send, switchThread, capabilities, holder }: HarnessProps) {
  const store = new OmpRuntimeStore({ threadId: currentThread });
  const transitions = useConversationTransitions({
    store,
    send,
    capabilities,
    submitPrompt: async () => undefined,
    switchThread,
    pickCount: () => 0,
    deliverNote: () => undefined,
    threadRunning: { current: false },
  });
  const rewind = useRewindPanel({
    threadId: currentThread,
    store,
    send,
    capabilities,
    transitions,
  });
  const surfaces: SurfaceMap = {
    todo: { title: "Todo checklist", render: () => <p>Todo body</p> },
    rewind,
  };
  return (
    <>
      <textarea aria-label="Composer input" />
      <LayoutArea area="panels" capabilities={capabilities} surfaces={surfaces} />
      <RegistryProbe holder={holder} />
    </>
  );
}

function app(props: HarnessProps, preferences: MemoryPreferenceStore): ReactNode {
  return (
    <ShortcutRegistryProvider descriptors={P4_DESCRIPTORS} preferenceStore={preferences}>
      <OverlayHost>
        <Harness {...props} />
      </OverlayHost>
    </ShortcutRegistryProvider>
  );
}

function renderRewind(overrides: Partial<HarnessProps> = {}) {
  const holder: { registry?: ShortcutRegistry } = {};
  const preferences = new MemoryPreferenceStore();
  const props: HarnessProps = {
    currentThread: threadId,
    send: fakeOmp([]),
    switchThread: async () => undefined,
    capabilities: AVAILABLE,
    holder,
    ...overrides,
  };
  const view = render(app(props, preferences));
  const composer = screen.getByRole("textbox", { name: "Composer input" });
  return {
    composer,
    registry(): ShortcutRegistry {
      if (holder.registry === undefined) throw new Error("The shortcut registry is not mounted.");
      return holder.registry;
    },
    switchTo(next: ThreadId): void {
      view.rerender(app({ ...props, currentThread: next }, preferences));
    },
  };
}

/** The palette runs the command the way the palette does: it calls the handler the feature registered. */
function openFromPalette(registry: ShortcutRegistry): void {
  const command = registry.commandFor(REWIND_COMMAND);
  if (command === undefined) throw new Error("The rewind command is not registered.");
  act(() => {
    void command.run();
  });
}

function chordEvent(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "H", ctrlKey: true, shiftKey: true });
}

describe("rewind availability and tree lookup", () => {
  test("the panel needs both the tree and the branch command", () => {
    expect(REWIND_CAPABILITIES).toEqual(["omp.cmd.get_tree", "omp.cmd.branch"]);
    expect(rewindAvailable(AVAILABLE)).toBe(true);
    expect(
      rewindAvailable({
        "omp.cmd.get_tree": AVAILABLE["omp.cmd.get_tree"] ?? { state: "unavailable", via: "rpc" },
      }),
    ).toBe(false);
  });

  test("finds an entry in a conversation thousands of entries deep, without recursion", () => {
    const depth = 20_000;
    let child: TreeNode | undefined;
    for (let index = depth - 1; index >= 0; index -= 1) {
      const id = `deep-${index}` as EntryId;
      child = {
        entry: message(id, index === 0 ? null : `deep-${index - 1}`, "user", `Message ${index}`, 1),
        children: child === undefined ? [] : [child],
      };
    }
    const found = treeEntry(child === undefined ? [] : [child], `deep-${depth - 1}` as EntryId);
    expect(found?.id).toBe(`deep-${depth - 1}`);
  });

  test("only a message of yours can be rewound to", () => {
    expect(isUserMessage(TREE[0]?.entry as SessionEntryHead)).toBe(true);
    expect(isUserMessage(TREE[0]?.children[0]?.entry as SessionEntryHead)).toBe(false);
  });
});

describe("rewind panel", () => {
  test("the palette command opens the tree, focuses it, and Escape closes it and returns focus", async () => {
    const { composer, registry } = renderRewind({ send: fakeOmp([]) });
    composer.focus();
    openFromPalette(registry());

    const tree = await screen.findByRole("tree", { name: "Conversation messages" });
    expect(
      screen.getByRole("tab", { name: "Conversation history" }).getAttribute("aria-selected"),
    ).toBe("true");
    await waitFor(() => expect(tree.contains(document.activeElement)).toBe(true));
    expect(document.activeElement?.getAttribute("role")).toBe("treeitem");

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(composer));
    expect(screen.queryByRole("tree", { name: "Conversation messages" })).toBeNull();
  });
  test("keeps retrying until a newly available tree row can take focus", async () => {
    const realFocus = HTMLElement.prototype.focus;
    let allowTreeFocus = false;
    HTMLElement.prototype.focus = function focusProbe(
      this: HTMLElement,
      ...args: Parameters<HTMLElement["focus"]>
    ) {
      if (this.getAttribute("role") === "treeitem" && !allowTreeFocus) return;
      realFocus.apply(this, args);
    };
    try {
      const { composer, registry } = renderRewind({ send: fakeOmp([]) });
      composer.focus();
      openFromPalette(registry());
      const tree = await screen.findByRole("tree", { name: "Conversation messages" });
      await screen.findAllByRole("treeitem");
      expect(document.activeElement).toBe(composer);
      allowTreeFocus = true;
      await waitFor(() => expect(tree.contains(document.activeElement)).toBe(true), {
        timeout: 2_000,
      });
    } finally {
      HTMLElement.prototype.focus = realFocus;
    }
  });
  test("an added row gets the latest-row fallback before the retry interval", async () => {
    const realFocus = HTMLElement.prototype.focus;
    const interval = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((() => 0) as unknown as typeof setInterval);
    const gate = Promise.withResolvers<void>();
    let allowTreeFocus = false;
    HTMLElement.prototype.focus = function focusProbe(
      this: HTMLElement,
      ...args: Parameters<HTMLElement["focus"]>
    ) {
      if (this.getAttribute("role") === "treeitem" && !allowTreeFocus) return;
      realFocus.apply(this, args);
    };
    try {
      const { composer, registry } = renderRewind({ send: heldOmp(gate.promise) });
      composer.focus();
      openFromPalette(registry());
      await screen.findByText("Loading");
      gate.resolve();
      const tree = await screen.findByRole("tree", { name: "Conversation messages" });
      await screen.findAllByRole("treeitem");
      for (const row of tree.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
        row.setAttribute("tabindex", "-1");
      }
      allowTreeFocus = true;
      act(() => {
        tree.append(document.createElement("span"));
      });
      await waitFor(() => expect(tree.contains(document.activeElement)).toBe(true));
      expect(document.activeElement).toBe(tree.querySelector('[role="treeitem"]:last-of-type'));
    } finally {
      interval.mockRestore();
      HTMLElement.prototype.focus = realFocus;
    }
  });

  test("Escape returns focus to an edit box that opened the panel", async () => {
    const { composer, registry } = renderRewind({ send: fakeOmp([]) });
    composer.setAttribute("aria-label", "Edit message");
    const mainComposer = document.createElement("textarea");
    mainComposer.setAttribute("aria-label", "Message input");
    document.body.appendChild(mainComposer);
    composer.focus();
    openFromPalette(registry());
    await screen.findByRole("tree", { name: "Conversation messages" });
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("treeitem"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("tree", { name: "Conversation messages" })).toBeNull(),
    );
    expect(document.activeElement).toBe(composer);
    mainComposer.remove();
  });
  test("Escape falls back to the mounted composer after the opener is removed", async () => {
    const { composer, registry } = renderRewind({ send: fakeOmp([]) });
    const replacement = document.createElement("textarea");
    replacement.setAttribute("aria-label", "Message input");
    document.body.appendChild(replacement);
    composer.focus();
    openFromPalette(registry());
    await screen.findByRole("tree", { name: "Conversation messages" });
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("treeitem"));
    composer.remove();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("tree", { name: "Conversation messages" })).toBeNull(),
    );
    expect(document.activeElement).toBe(replacement);
    replacement.remove();
  });

  test("without omp's tree or branch command there is no tab, palette command or chord", () => {
    const { registry } = renderRewind({
      capabilities: {
        "omp.cmd.get_tree": AVAILABLE["omp.cmd.get_tree"] ?? { state: "unavailable", via: "rpc" },
      },
    });
    expect(registry().commandFor(REWIND_COMMAND)).toBeUndefined();
    expect(registry().dispatch(chordEvent(), "global").handled).toBe(false);
    expect(screen.queryByRole("tab", { name: "Conversation history" })).toBeNull();
  });

  test("the chord opens the panel when it is pressed in the composer", async () => {
    const { composer, registry } = renderRewind({ send: fakeOmp([]) });
    composer.focus();
    const event = chordEvent();
    composer.dispatchEvent(event);
    expect(registry().dispatch(event, "global").handled).toBe(true);
    expect(await screen.findByRole("tree", { name: "Conversation messages" })).toBeTruthy();
  });

  test("choosing one of your messages runs R0.4's branch and switches to the new session", async () => {
    const calls: string[] = [];
    const switched: ThreadId[] = [];
    const { registry } = renderRewind({
      send: fakeOmp(calls),
      switchThread: async (next) => {
        switched.push(next);
      },
    });
    openFromPalette(registry());

    const row = await screen.findByRole("treeitem", { name: /Run the tests first/ });
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });

    await waitFor(() => expect(switched).toEqual(["branched-thread"]));
    expect(calls).toEqual(expect.arrayContaining(["get_tree", "branch e-3", "get_state"]));
  });

  test("an assistant message cannot be rewound to, and the panel says why", async () => {
    const calls: string[] = [];
    const { registry } = renderRewind({ send: fakeOmp(calls) });
    openFromPalette(registry());

    const reply = await screen.findByRole("treeitem", { name: /All tests pass/ });
    fireEvent.click(reply);
    fireEvent.keyDown(reply, { key: "Enter" });

    expect(await screen.findByText("Choose one of your messages to rewind to.")).toBeTruthy();
    expect(calls.some((call) => call.startsWith("branch"))).toBe(false);
  });

  test("the picker dialog rewinds to the message chosen in it", async () => {
    const calls: string[] = [];
    const switched: ThreadId[] = [];
    const { registry } = renderRewind({
      send: fakeOmp(calls),
      switchThread: async (next) => {
        switched.push(next);
      },
    });
    openFromPalette(registry());
    await screen.findByRole("tree", { name: "Conversation messages" });

    fireEvent.click(screen.getByRole("button", { name: "Choose a message" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a message" });
    fireEvent.click(within(dialog).getByRole("treeitem", { name: /Run the tests first/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Rewind here" }));

    await waitFor(() => expect(switched).toEqual(["branched-thread"]));
    expect(calls).toContain("branch e-3");
  });
  test("forks the marked message even after focus moves, then switches to the fork", async () => {
    const calls: string[] = [];
    const switched: ThreadId[] = [];
    const { registry } = renderRewind({
      send: fakeOmp(calls),
      switchThread: async (next) => {
        switched.push(next);
      },
    });
    openFromPalette(registry());
    await screen.findByRole("tree", { name: "Conversation messages" });
    fireEvent.click(screen.getByRole("button", { name: "Choose a message" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a message" });
    const marked = within(dialog).getByRole("treeitem", { name: /Run the tests first/ });
    fireEvent.click(marked);
    within(dialog)
      .getByRole("treeitem", { name: /All tests pass/ })
      .focus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Fork here" }));
    await waitFor(() => expect(switched).toEqual(["branched-thread"]));
    expect(calls).toContain("fork e-3");
  });

  test("explains when forking is unavailable and omits the action", async () => {
    const capabilities = { ...AVAILABLE };
    delete capabilities["omp.cmd.fork"];
    const { registry } = renderRewind({ capabilities });
    openFromPalette(registry());
    await screen.findByRole("tree", { name: "Conversation messages" });
    fireEvent.click(screen.getByRole("button", { name: "Choose a message" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a message" });
    expect(within(dialog).queryByRole("button", { name: "Fork here" })).toBeNull();
    expect(within(dialog).getByText(/Fork isn't available with this version of omp/)).toBeTruthy();
  });

  test("shows a safe fork failure message", async () => {
    const calls: string[] = [];
    const { registry } = renderRewind({ send: fakeOmp(calls, true) });
    openFromPalette(registry());
    await screen.findByRole("tree", { name: "Conversation messages" });
    fireEvent.click(screen.getByRole("button", { name: "Choose a message" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a message" });
    fireEvent.click(within(dialog).getByRole("treeitem", { name: /Run the tests first/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Fork here" }));
    expect(await screen.findByText("The conversation couldn't be forked. Try again.")).toBeTruthy();
    expect(calls).toContain("fork e-3");
  });

  test("does not fork the marked non-message row", async () => {
    const calls: string[] = [];
    const { registry } = renderRewind({ send: fakeOmp(calls) });
    openFromPalette(registry());
    await screen.findByRole("tree", { name: "Conversation messages" });
    fireEvent.click(screen.getByRole("button", { name: "Choose a message" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a message" });
    fireEvent.click(within(dialog).getByRole("treeitem", { name: /Saved summary/ }));
    expect(within(dialog).getByRole("button", { name: "Fork here" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(calls.some((call) => call.startsWith("fork"))).toBe(false);
  });

  test("switching to another conversation closes the panel", async () => {
    const { registry, switchTo } = renderRewind({ send: fakeOmp([]) });
    openFromPalette(registry());
    await screen.findByRole("tree", { name: "Conversation messages" });

    switchTo(otherThread);

    await waitFor(() =>
      expect(screen.queryByRole("tree", { name: "Conversation messages" })).toBeNull(),
    );
  });

  test("S9b /tree opens the conversation tree, focuses a row, and Escape returns focus to the message box", async () => {
    const { composer, registry } = renderRewind({ send: fakeOmp([]) });
    composer.focus();
    const panel: HistoryPanel = {
      available: () => registry().commandFor(REWIND_COMMAND) !== undefined,
      open: () => void registry().commandFor(REWIND_COMMAND)?.run(),
    };

    const result = await act(async () => treeSlashCommand({ panel }).run({}));
    expect(result).toEqual({
      message: "Browse this chat's messages here. Rewinding opens a new chat and keeps this one.",
    });

    const tree = await screen.findByRole("tree", { name: "Conversation messages" });
    await waitFor(() => expect(tree.contains(document.activeElement)).toBe(true));
    expect(document.activeElement?.getAttribute("role")).toBe("treeitem");

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });
});
