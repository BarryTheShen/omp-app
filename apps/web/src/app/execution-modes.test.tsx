import type { AppClient } from "@omp-app/client";
import {
  type CapabilityMap,
  CapabilityStatus,
  type ModeChangeRequest,
  type ModeChangeResult,
  modeChangeCommand,
  OmpCommandGateway,
  type ThreadId,
} from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { LAYOUT, LayoutArea } from "@/layout";
import { D7_EXECUTION_MODES_COMMAND } from "@/modules/D7/modes";
import { OverlayHost } from "@/overlay";
import {
  MemoryPreferenceStore,
  type ShortcutRegistry,
  ShortcutRegistryProvider,
  useShortcutRegistry,
} from "@/shortcuts";
import { useExecutionModesSurface } from "./execution-modes";

afterEach(() => cleanup());

// One array for every render: the provider rebuilds its registry whenever this identity changes.
const DESCRIPTORS = [D7_EXECUTION_MODES_COMMAND] as const;
const CHAT_A = "chat-a" as ThreadId;
const CHAT_B = "chat-b" as ThreadId;

const AVAILABLE: CapabilityMap = {
  "host.command-gateway": CapabilityStatus.parse({ state: "available", via: "host" }),
  "omp.cmd.get_state": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  "omp.cmd.set_fast_mode": CapabilityStatus.parse({ state: "available", via: "rpc" }),
};

/** A client whose command gateway completes every command and whose session answers get_state. */
function fakeClient(): { readonly client: AppClient; readonly commands: string[] } {
  const commands: string[] = [];
  const gateway = {
    modeChange: async ({
      request,
    }: {
      readonly request: ModeChangeRequest;
    }): Promise<ModeChangeResult> => {
      commands.push(modeChangeCommand(request));
      return request.mode === "browser"
        ? { outcome: "applied", mode: "browser", visibility: request.visibility }
        : { outcome: "applied", mode: request.mode, on: request.requested };
    },
  };
  const rpc = {
    send: async () => ({ sessionId: "session", fastModeEnabled: false, fastModeActive: false }),
  };
  const client = {
    port: (port: unknown) => (port === OmpCommandGateway ? gateway : rpc),
  } as unknown as AppClient;
  return { client, commands };
}

interface HarnessProps {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  readonly holder: { registry?: ShortcutRegistry };
  /** False unmounts the open chat, as when the person leaves it. */
  readonly mounted?: boolean;
}

/** The open chat's composer toolbar with the execution-modes control, and the registry the chat registers in. */
function Harness({ client, threadId, capabilities, holder }: Omit<HarnessProps, "mounted">) {
  const executionModes = useExecutionModesSurface({ client, threadId, capabilities });
  holder.registry = useShortcutRegistry();
  return (
    <>
      <textarea aria-label="Message input" />
      <LayoutArea area="composerToolbar" surfaces={{ executionModes }} />
    </>
  );
}

function app({ mounted = true, ...props }: HarnessProps, preferences: MemoryPreferenceStore) {
  return (
    <ShortcutRegistryProvider descriptors={DESCRIPTORS} preferenceStore={preferences}>
      <OverlayHost>{mounted ? <Harness {...props} /> : <p>No chat is open.</p>}</OverlayHost>
    </ShortcutRegistryProvider>
  );
}

function setup(overrides: Partial<HarnessProps> = {}) {
  const { client, commands } = fakeClient();
  const holder: { registry?: ShortcutRegistry } = {};
  const preferences = new MemoryPreferenceStore();
  const props: HarnessProps = {
    client,
    threadId: CHAT_A,
    capabilities: AVAILABLE,
    holder,
    ...overrides,
  };
  const view = render(app(props, preferences));
  const rerenderWith = (next: Partial<HarnessProps>) =>
    view.rerender(app({ ...props, ...next }, preferences));
  return { commands, holder, rerenderWith };
}

/** The "Turn on" or "Turn off" button of one mode's group in the open dialog. */
function modeButton(dialog: HTMLElement, group: string, name: "Turn on" | "Turn off"): HTMLElement {
  return within(within(dialog).getByRole("group", { name: group })).getByRole("button", { name });
}

async function openFromToolbar(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Execution modes" }));
  return screen.findByRole("dialog", { name: "Execution modes" });
}

async function closeWithDone(dialog: HTMLElement): Promise<void> {
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Execution modes" })).toBeNull());
}

describe("where the execution-modes control sits", () => {
  test("is one of the composer's toolbar controls, right after the input mode", () => {
    expect(LAYOUT.composerToolbar).toContain("executionModes");
    expect(LAYOUT.composerToolbar.indexOf("executionModes")).toBe(
      LAYOUT.composerToolbar.indexOf("mode") + 1,
    );
  });

  test("is not a header control, so the title keeps its room beside the model control", () => {
    expect(LAYOUT.header).not.toContain("executionModes");
  });

  test("is not a status bar item, so the context readout keeps the status bar's room", () => {
    expect(LAYOUT.statusBar).not.toContain("executionModes");
  });
});

describe("the execution-modes control in the composer toolbar", () => {
  test("opens the controls of this chat, and Done closes them", async () => {
    setup();
    const dialog = await openFromToolbar();
    expect(within(dialog).getByRole("group", { name: "Slow mode controls" })).toBeTruthy();
    await closeWithDone(dialog);
  });

  test("a choice made in this chat is still set after the dialog closes and opens again", async () => {
    const { commands } = setup();
    const dialog = await openFromToolbar();
    fireEvent.click(modeButton(dialog, "Slow mode controls", "Turn on"));
    await waitFor(() =>
      expect(modeButton(dialog, "Slow mode controls", "Turn on").getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    expect(commands).toEqual(["/slow on"]);
    await closeWithDone(dialog);

    const reopened = await openFromToolbar();
    expect(modeButton(reopened, "Slow mode controls", "Turn on").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  test("a choice made in one chat does not show in another chat", async () => {
    const { rerenderWith } = setup();
    const dialog = await openFromToolbar();
    fireEvent.click(modeButton(dialog, "Slow mode controls", "Turn on"));
    await waitFor(() =>
      expect(modeButton(dialog, "Slow mode controls", "Turn on").getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    await closeWithDone(dialog);

    rerenderWith({ threadId: CHAT_B });
    const other = await openFromToolbar();
    expect(modeButton(other, "Slow mode controls", "Turn on").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  test("capabilities that arrive after the chat opened reach its controls", async () => {
    const { rerenderWith } = setup({
      capabilities: {
        ...AVAILABLE,
        "host.command-gateway": CapabilityStatus.parse({
          state: "unavailable",
          via: "host",
          detail: "The command service is offline.",
        }),
      },
    });
    const dialog = await openFromToolbar();
    expect(modeButton(dialog, "Slow mode controls", "Turn on")).toHaveProperty("disabled", true);

    rerenderWith({ capabilities: AVAILABLE });
    await waitFor(() =>
      expect(modeButton(dialog, "Slow mode controls", "Turn on")).toHaveProperty("disabled", false),
    );
  });
});

describe("the palette's execution-modes command", () => {
  test("opens the same dialog for the open chat", async () => {
    const { holder } = setup();
    act(() => {
      holder.registry?.commandFor(D7_EXECUTION_MODES_COMMAND.id)?.run();
    });
    expect(await screen.findByRole("dialog", { name: "Execution modes" })).toBeTruthy();
  });

  test("is removed when the chat that registered it unmounts", () => {
    const { holder, rerenderWith } = setup();
    expect(holder.registry?.commandFor(D7_EXECUTION_MODES_COMMAND.id)).toBeDefined();
    rerenderWith({ mounted: false });
    expect(holder.registry?.commandFor(D7_EXECUTION_MODES_COMMAND.id)).toBeUndefined();
  });
});
