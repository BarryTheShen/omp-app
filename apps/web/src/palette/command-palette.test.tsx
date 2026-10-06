import type {
  CapabilityKey,
  CapabilityMap,
  CapabilityStatus,
  CommandDescriptor,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OverlayHost } from "@/overlay";
import { DESCRIPTORS, RENDERERS, registry } from "@/registry";
import { RegistryProvider } from "@/registry-core";
import { MemoryPreferenceStore, ShortcutRegistry, ShortcutRegistryProvider } from "@/shortcuts";
import { CommandPaletteHost, U0_COMMAND_PALETTE_SHORTCUT } from "./index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const commandDescriptors: readonly CommandDescriptor[] = DESCRIPTORS.filter(
  (descriptor): descriptor is CommandDescriptor => descriptor.kind === "command",
);

function commandWithRequirements(): CommandDescriptor {
  const command = commandDescriptors.find((descriptor) => descriptor.requires.length > 0);
  if (command === undefined) throw new Error("The composed registry has no gated commands.");
  return command;
}

function capabilityVia(key: CapabilityKey): CapabilityStatus["via"] {
  if (key.startsWith("omp.")) return "rpc";
  if (key.startsWith("host.")) return "host";
  if (key.startsWith("client.")) return "client";
  return "upstream";
}

function capabilitiesFor(
  command: CommandDescriptor,
  state: CapabilityStatus["state"],
  detail?: string,
): CapabilityMap {
  const capabilities: CapabilityMap = {};
  for (const key of command.requires) {
    capabilities[key] = {
      state,
      via: capabilityVia(key),
      ...(detail === undefined ? {} : { detail }),
    };
  }
  return capabilities;
}
function capabilitiesForCommands(
  commands: readonly CommandDescriptor[],
  state: CapabilityStatus["state"],
): CapabilityMap {
  const capabilities: CapabilityMap = {};
  for (const command of commands) {
    for (const key of command.requires) {
      capabilities[key] = { state, via: capabilityVia(key) };
    }
  }
  return capabilities;
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
  onCommandSelect: (command: CommandDescriptor) => void = () => undefined,
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
          <CommandPaletteHost onCommandSelect={onCommandSelect} />
        </OverlayHost>
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

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  test("shows every registry command without exposing descriptor ids", async () => {
    renderPalette();
    await openPalette();

    const options = screen.getAllByRole("option");
    const optionText = options.map((option) => option.textContent ?? "");
    expect(options).toHaveLength(commandDescriptors.length);
    for (const descriptor of commandDescriptors) {
      expect(optionText.some((text) => text.includes(descriptor.title))).toBe(true);
      expect(optionText.every((text) => !text.includes(descriptor.id))).toBe(true);
    }
  });

  test("keeps unavailable commands visible but disabled with a plain-English reason", async () => {
    const command = commandDescriptors.find((descriptor) =>
      descriptor.requires.some((key) => key.startsWith("omp.cmd.")),
    );
    if (command === undefined) throw new Error("The composed registry has no RPC command.");
    const rpcKey = command.requires.find((key) => key.startsWith("omp.cmd."));
    if (rpcKey === undefined) throw new Error("Expected an RPC capability.");
    const capabilities = capabilitiesFor(command, "available");
    capabilities[rpcKey] = {
      state: "unavailable",
      via: "rpc",
      detail: `The ${rpcKey} check failed`,
    };
    const onCommandSelect = vi.fn<(selected: CommandDescriptor) => void>();
    renderPalette(capabilities, onCommandSelect);
    await openPalette();

    const option = optionFor(command);
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain(
      "The connected omp process does not support this command.",
    );
    expect(option.textContent).not.toContain(rpcKey);
    fireEvent.click(option);
    expect(onCommandSelect).not.toHaveBeenCalled();
  });

  test("treats fallback capabilities as usable and filters/selects the matching descriptor", async () => {
    const command = commandWithRequirements();
    const capabilities = capabilitiesFor(
      command,
      "fallback",
      "Some advanced options are unavailable.",
    );
    const onCommandSelect = vi.fn<(selected: CommandDescriptor) => void>();
    renderPalette(capabilities, onCommandSelect);
    await openPalette();

    const search = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.change(search, { target: { value: command.title } });
    const option = optionFor(command);
    expect(option.getAttribute("aria-disabled")).toBe("false");
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onCommandSelect).toHaveBeenCalledWith(command);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull(),
    );
  });
  test("moves through the registry command list with arrow keys", async () => {
    const selected = commandDescriptors[1];
    if (selected === undefined) throw new Error("Expected at least two commands.");
    const onCommandSelect = vi.fn<(command: CommandDescriptor) => void>();
    renderPalette(capabilitiesForCommands(commandDescriptors, "available"), onCommandSelect);
    await openPalette();

    const search = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onCommandSelect).toHaveBeenCalledWith(selected);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull(),
    );
  });

  test("explains unconfirmed capabilities without showing internal names", async () => {
    const command = commandWithRequirements();
    renderPalette();
    await openPalette();

    const option = optionFor(command);
    expect(option.textContent).toContain(
      "The current session has not confirmed that this command is available.",
    );
    for (const key of command.requires) expect(option.textContent).not.toContain(key);
  });

  test("does not bind a chord the shortcut registry marks as browser-reserved", async () => {
    vi.spyOn(ShortcutRegistry.prototype, "isBrowserReserved").mockReturnValue(true);
    renderPalette();
    const opener = screen.getByRole("button", { name: "Return to app" });
    fireEvent.keyDown(opener, { key: "k", ctrlKey: true });

    await waitFor(() => expect(ShortcutRegistry.prototype.isBrowserReserved).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  test("shows an empty search state and keeps command-start failures recoverable", async () => {
    const command = commandWithRequirements();
    const onCommandSelect = vi.fn(() => {
      throw new Error("private command details");
    });
    renderPalette(capabilitiesFor(command, "available"), onCommandSelect);
    await openPalette();
    const search = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.change(search, { target: { value: "no command matches this phrase" } });
    expect(screen.getByRole("status").textContent).toBe("No commands found.");

    fireEvent.change(search, { target: { value: command.title } });
    fireEvent.keyDown(search, { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The command could not be started. Try again.");
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(screen.queryByText("private command details")).toBeNull();
  });
});
