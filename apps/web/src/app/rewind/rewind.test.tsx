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
import { afterEach, describe, expect, test } from "vitest";
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
import { type RewindPanelOptions, useRewindPanel } from "./use-rewind-panel";

afterEach(cleanup);

const threadId = "rewind-thread" as ThreadId;
const otherThread = "other-thread" as ThreadId;
const REWIND_COMMAND = "P4.tree" as DescriptorId;

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
];

const AVAILABLE: CapabilityMap = {
  "omp.cmd.get_tree": { state: "available", via: "rpc" },
  "omp.cmd.branch": { state: "available", via: "rpc" },
};

/** A fake omp: the tree, a branch that always succeeds, and the new session's identity. */
function fakeOmp(calls: string[]): RpcSessionSend {
  const answer = async (args: { command: { type: string; entryId?: string } }) => {
    const { command } = args;
    calls.push(command.type === "branch" ? `branch ${command.entryId}` : command.type);
    if (command.type === "get_tree") return { tree: TREE, leafId: "e-4" };
    if (command.type === "branch") return { text: "", cancelled: false };
    if (command.type === "get_state") return { sessionId: "branched-thread" };
    throw new Error(`The fake omp does not answer ${command.type}.`);
  };
  return answer as unknown as RpcSessionSend;
}

interface HarnessProps {
  readonly currentThread: ThreadId;
  readonly send: RpcSessionSend;
  readonly switchThread: RewindPanelOptions["switchThread"];
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
  const rewind = useRewindPanel({
    threadId: currentThread,
    store,
    send,
    capabilities,
    submitPrompt: async () => undefined,
    switchThread,
    pickCount: () => 0,
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
    const dialog = await screen.findByRole("dialog", { name: "Choose where to rewind" });
    fireEvent.click(within(dialog).getByRole("treeitem", { name: /Run the tests first/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Rewind here" }));

    await waitFor(() => expect(switched).toEqual(["branched-thread"]));
    expect(calls).toContain("branch e-3");
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
});
