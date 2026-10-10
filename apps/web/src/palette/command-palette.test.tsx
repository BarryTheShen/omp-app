import type {
  CapabilityKey,
  CapabilityMap,
  CapabilityStatus,
  CommandDescriptor,
  DescriptorId,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OverlayHost } from "@/overlay";
import { DESCRIPTORS, RENDERERS, registry } from "@/registry";
import { RegistryProvider } from "@/registry-core";
import {
  MemoryPreferenceStore,
  ShortcutRegistry,
  ShortcutRegistryProvider,
  useShortcutRegistry,
} from "@/shortcuts";
import {
  type CommandPaletteHandler,
  CommandPaletteHost,
  U0_COMMAND_PALETTE_SHORTCUT,
} from "./index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function commandById(id: string): CommandDescriptor {
  const command = DESCRIPTORS.find(
    (descriptor): descriptor is CommandDescriptor =>
      descriptor.kind === "command" && descriptor.id === id,
  );
  if (command === undefined) throw new Error(`The composed registry has no command ${id}.`);
  return command;
}

const NEW_CHAT = commandById("D5.new");
const FRESH = commandById("D5.fresh");
const CLEAR = commandById("D5.clear");
// A registered command with a slash that the app has not mounted: it must never be listed.
const MODEL = commandById("D1.model");

function capabilityVia(key: CapabilityKey): CapabilityStatus["via"] {
  if (key.startsWith("omp.")) return "rpc";
  if (key.startsWith("host.")) return "host";
  if (key.startsWith("client.")) return "client";
  return "upstream";
}

function capabilitiesFor(
  commands: readonly CommandDescriptor[],
  state: CapabilityStatus["state"],
  detail?: string,
): CapabilityMap {
  const capabilities: CapabilityMap = {};
  for (const command of commands) {
    for (const key of command.requires) {
      capabilities[key] = {
        state,
        via: capabilityVia(key),
        ...(detail === undefined ? {} : { detail }),
      };
    }
  }
  return capabilities;
}

function handlersFor(
  ...entries: readonly (readonly [CommandDescriptor, CommandPaletteHandler])[]
): ReadonlyMap<DescriptorId, CommandPaletteHandler> {
  return new Map(entries.map(([command, handler]) => [command.id, handler]));
}

function optionFor(command: CommandDescriptor): HTMLElement {
  const option = screen
    .getAllByRole("option")
    .find((candidate) => candidate.textContent?.includes(command.title));
  if (option === undefined) throw new Error(`Missing command option: ${command.title}`);
  return option;
}

function renderPalette(
  capabilities: CapabilityMap = {},
  handlers: ReadonlyMap<DescriptorId, CommandPaletteHandler> = new Map(),
  unavailableReasons: ReadonlyMap<DescriptorId, string> = new Map(),
  extra: ReactNode = null,
) {
  const shortcutDescriptors = [
    ...DESCRIPTORS.filter((descriptor) => descriptor.id !== U0_COMMAND_PALETTE_SHORTCUT.id),
    U0_COMMAND_PALETTE_SHORTCUT,
  ];
  return render(
    <RegistryProvider capabilities={capabilities} registry={registry} renderers={RENDERERS}>
      <ShortcutRegistryProvider
        descriptors={shortcutDescriptors}
        preferenceStore={new MemoryPreferenceStore()}
      >
        <OverlayHost>
          <button type="button">Return to app</button>
          <textarea aria-label="Composer input" />
          <CommandPaletteHost handlers={handlers} unavailableReasons={unavailableReasons} />
        </OverlayHost>
        {extra}
      </ShortcutRegistryProvider>
    </RegistryProvider>,
  );
}

async function openPalette(): Promise<HTMLElement> {
  const opener = screen.getByRole("button", { name: "Return to app" });
  opener.focus();
  fireEvent.keyDown(opener, { key: "k", ctrlKey: true });
  return screen.findByRole("dialog", { name: "Command palette" });
}

async function expectPaletteClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
}

describe("U0 command palette", () => {
  test("opens from the composer through the shortcut registry and restores focus", async () => {
    const isBrowserReserved = vi.spyOn(ShortcutRegistry.prototype, "isBrowserReserved");
    renderPalette();
    const opener = screen.getByRole("textbox", { name: "Composer input" });
    opener.focus();
    fireEvent.keyDown(opener, { key: "k", ctrlKey: true });

    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const search = screen.getByRole("combobox", { name: "Search commands" });
    expect(isBrowserReserved).toHaveBeenCalledWith("Mod+K", "global");
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "Escape" });

    await expectPaletteClosed();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  test("lists only the commands the app has a handler for, by their plain titles", async () => {
    renderPalette(
      capabilitiesFor([NEW_CHAT, FRESH], "available"),
      handlersFor([NEW_CHAT, () => undefined], [FRESH, () => undefined]),
    );
    await openPalette();

    const titles = screen.getAllByRole("option").map((option) => option.textContent ?? "");
    expect(titles).toHaveLength(2);
    expect(titles.some((text) => text.includes(NEW_CHAT.title))).toBe(true);
    expect(titles.some((text) => text.includes(FRESH.title))).toBe(true);
    // Registered, with a slash, but not mounted in the app: not offered.
    expect(titles.every((text) => !text.includes(MODEL.title))).toBe(true);
    expect(titles.every((text) => !text.includes(NEW_CHAT.id))).toBe(true);
  });

  test("a theme command is listed for a search only when the app has mounted it", async () => {
    const DARK = commandById("U0.themeDark");
    const setDark = vi.fn();
    renderPalette(capabilitiesFor([DARK], "available"), handlersFor([DARK, setDark]));
    await openPalette();
    fireEvent.change(screen.getByRole("combobox", { name: "Search commands" }), {
      target: { value: "theme" },
    });
    fireEvent.click(optionFor(DARK));
    expect(setDark).toHaveBeenCalledTimes(1);

    cleanup();
    renderPalette(capabilitiesFor([DARK], "available"));
    await openPalette();
    fireEvent.change(screen.getByRole("combobox", { name: "Search commands" }), {
      target: { value: "theme" },
    });
    expect(screen.getByRole("status").textContent).toBe("No commands found.");
  });

  test("shows an empty state when the app has mounted no command", async () => {
    renderPalette();
    await openPalette();

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("No commands found.");
  });

  test("runs the chosen command's handler and closes", async () => {
    const handler = vi.fn<CommandPaletteHandler>();
    renderPalette(capabilitiesFor([NEW_CHAT], "available"), handlersFor([NEW_CHAT, handler]));
    await openPalette();

    fireEvent.click(optionFor(NEW_CHAT));

    await waitFor(() => expect(handler).toHaveBeenCalledWith(expect.any(AbortSignal)));
    await expectPaletteClosed();
  });

  test("filters by title and runs the match on Enter; a fallback capability still counts", async () => {
    const handler = vi.fn<CommandPaletteHandler>();
    renderPalette(
      capabilitiesFor([NEW_CHAT, FRESH], "fallback", "Some advanced options are unavailable."),
      handlersFor([NEW_CHAT, () => undefined], [FRESH, handler]),
    );
    await openPalette();

    const search = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.change(search, { target: { value: "fresh" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(optionFor(FRESH).getAttribute("aria-disabled")).toBe("false");
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await expectPaletteClosed();
  });

  test("moves the highlight with the arrow keys and runs that command", async () => {
    const first = vi.fn<CommandPaletteHandler>();
    const second = vi.fn<CommandPaletteHandler>();
    renderPalette(
      capabilitiesFor([NEW_CHAT, FRESH], "available"),
      handlersFor([NEW_CHAT, first], [FRESH, second]),
    );
    await openPalette();

    const search = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(first).not.toHaveBeenCalled();
    await expectPaletteClosed();
  });

  test("keeps an unavailable command visible but disabled, with a plain reason and no internal names", async () => {
    const handler = vi.fn<CommandPaletteHandler>();
    const capabilities = capabilitiesFor([NEW_CHAT], "unavailable", "the new_session probe failed");
    renderPalette(capabilities, handlersFor([NEW_CHAT, handler]));
    await openPalette();

    const option = optionFor(NEW_CHAT);
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain(
      "The connected omp process does not support this command.",
    );
    for (const key of NEW_CHAT.requires) expect(option.textContent).not.toContain(key);
    fireEvent.click(option);
    expect(handler).not.toHaveBeenCalled();
  });

  test("shows the app's own reason for a command it knows is unavailable", async () => {
    const reason = "Clearing the conversation only works in the omp terminal for now.";
    renderPalette(
      capabilitiesFor([CLEAR], "unavailable"),
      handlersFor([CLEAR, () => undefined]),
      new Map([[CLEAR.id, reason]]),
    );
    await openPalette();

    const option = optionFor(CLEAR);
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain(reason);
  });

  test("explains a capability the session has not confirmed, without internal names", async () => {
    renderPalette({}, handlersFor([NEW_CHAT, () => undefined]));
    await openPalette();

    const option = optionFor(NEW_CHAT);
    expect(option.textContent).toContain(
      "The current session has not confirmed that this command is available.",
    );
    for (const key of NEW_CHAT.requires) expect(option.textContent).not.toContain(key);
  });

  test("does not bind a chord the shortcut registry marks as browser-reserved", async () => {
    vi.spyOn(ShortcutRegistry.prototype, "isBrowserReserved").mockReturnValue(true);
    renderPalette();
    const opener = screen.getByRole("button", { name: "Return to app" });
    fireEvent.keyDown(opener, { key: "k", ctrlKey: true });

    await waitFor(() => expect(ShortcutRegistry.prototype.isBrowserReserved).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  test("keeps a failing command recoverable and never shows its private details", async () => {
    const failing = vi.fn(() => {
      throw new Error("private command details");
    });
    renderPalette(capabilitiesFor([NEW_CHAT], "available"), handlersFor([NEW_CHAT, failing]));
    await openPalette();
    const search = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.change(search, { target: { value: "no command matches this phrase" } });
    expect(screen.getByRole("status").textContent).toBe("No commands found.");

    fireEvent.change(search, { target: { value: NEW_CHAT.title } });
    fireEvent.keyDown(search, { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The command could not be started. Try again.");
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(screen.queryByText("private command details")).toBeNull();
  });

  test("runs a command once even if chosen twice, and aborts it when the palette closes", async () => {
    let signal: AbortSignal | undefined;
    const handler = vi.fn<CommandPaletteHandler>((received) => {
      signal = received;
      return new Promise<void>(() => undefined);
    });
    renderPalette(capabilitiesFor([NEW_CHAT], "available"), handlersFor([NEW_CHAT, handler]));
    await openPalette();

    const search = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(signal?.aborted).toBe(false);

    fireEvent.keyDown(document.body, { key: "Escape" });
    await expectPaletteClosed();
    expect(signal?.aborted).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

/** The palette's own command list is the handlers it was given plus the commands features register. */
const TREE = commandById("P4.tree");

/** Registers a command the way a mounted feature does, while the palette is on screen. */
function CommandRegistrar({ run }: { readonly run: () => void }) {
  const shortcuts = useShortcutRegistry();
  useEffect(
    () => shortcuts.registerCommand(TREE.id, { run, shortcut: "P4.sessionTree" }),
    [run, shortcuts],
  );
  return null;
}

describe("U0 command palette: commands a feature registers", () => {
  test("lists a registered command with the chord that runs it, and runs it", async () => {
    const run = vi.fn<() => void>();
    renderPalette(
      capabilitiesFor([TREE], "available"),
      new Map(),
      new Map(),
      <CommandRegistrar run={run} />,
    );
    await openPalette();
    const option = optionFor(TREE);
    expect(within(option).getByText("Mod+Shift+H")).toBeTruthy();
    fireEvent.click(option);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await expectPaletteClosed();
  });

  test("does not list a command that no feature registered", async () => {
    renderPalette(capabilitiesFor([TREE], "available"));
    await openPalette();
    expect(screen.queryByRole("option", { name: /Conversation tree/ })).toBeNull();
  });
});
