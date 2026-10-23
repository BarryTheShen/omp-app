import type { ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { conversationBusy } from "@/app/rewind/rewind-tree";
import type { ConversationTransitionPort } from "@/modules/P4/transitions";
import { OmpRuntimeStore } from "@/modules/R0/store";
import {
  branchSlashCommand,
  clearSlashCommand,
  forkSlashCommand,
  type HistoryPanel,
  restartSlashCommand,
} from "./slash-commands";

const THREAD = "busy-thread" as ThreadId;

/** A chat whose turn runs a tool: the composer's running flag is on, and the store holds no streaming reply. */
function toolStepBusy(): () => boolean {
  const store = new OmpRuntimeStore({ threadId: THREAD });
  return () => conversationBusy(store, true);
}

/** A chat whose reply streams text: the composer's running flag is on, and the store streams the reply. */
function textStreamingBusy(): () => boolean {
  const store = new OmpRuntimeStore({ threadId: THREAD });
  store.applySessionState({ isStreaming: true });
  return () => conversationBusy(store, true);
}

const BUSY_STATES: [string, () => () => boolean][] = [
  ["a turn runs a tool", toolStepBusy],
  ["a reply streams text", textStreamingBusy],
];

describe.each(BUSY_STATES)("#2520 while %s", (_state, busyState) => {
  test("/clear says to wait and starts no chat", async () => {
    const openStarted = vi.fn(async () => undefined);
    const deliverNote = vi.fn();
    const command = clearSlashCommand({
      lifecycle: null,
      openStarted,
      isBusy: busyState(),
      deliverNote,
      focusComposer: vi.fn(),
    });
    await expect(command.run({})).resolves.toEqual({
      message: "Wait for this chat's turn to finish, then clear it.",
    });
    expect(openStarted).not.toHaveBeenCalled();
    expect(deliverNote).not.toHaveBeenCalled();
  });

  test("/fork says to wait and forks nothing", async () => {
    const fork = vi.fn(async () => ({ cancelled: false, reloaded: true }));
    const command = forkSlashCommand({
      transitions: { fork } as unknown as ConversationTransitionPort,
      threadId: THREAD,
      isBusy: busyState(),
      deliverNote: vi.fn(),
      focusComposer: vi.fn(),
    });
    await expect(command.run({})).resolves.toEqual({
      message: "Wait for this chat's turn to finish, then fork it.",
    });
    expect(fork).not.toHaveBeenCalled();
  });

  test("/branch says to wait and opens no panel", async () => {
    const panel: HistoryPanel = { available: () => true, open: vi.fn() };
    const command = branchSlashCommand({ panel, isBusy: busyState() });
    await expect(command.run({})).resolves.toEqual({
      message: "Wait for this chat's turn to finish, then rewind it.",
    });
    expect(panel.open).not.toHaveBeenCalled();
  });

  test("/restart words its question for a running turn", async () => {
    const confirm = vi.fn(async () => false);
    const command = restartSlashCommand({
      confirm,
      restart: vi.fn(async () => undefined),
      isBusy: busyState(),
    });
    await command.run({});
    expect(confirm).toHaveBeenCalledWith(true);
  });
});
