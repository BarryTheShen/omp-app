import type {
  CapabilityKey,
  CapabilityMap,
  CapabilityStatus,
  DescriptorId,
} from "@omp-app/contracts";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Textarea } from "@/components/ui/textarea";
import { OverlayHost } from "@/overlay";
import { DESCRIPTORS, RENDERERS, registry } from "@/registry";
import { RegistryProvider } from "@/registry-core";
import { MemoryPreferenceStore, ShortcutRegistryProvider } from "@/shortcuts";
import {
  type CommandPaletteHandler,
  CommandPaletteHost,
  U0_COMMAND_PALETTE_SHORTCUT,
} from "./index";

const commandShortcutDescriptors = [
  ...DESCRIPTORS.filter((descriptor) => descriptor.id !== U0_COMMAND_PALETTE_SHORTCUT.id),
  U0_COMMAND_PALETTE_SHORTCUT,
];
const CLEAR_REASON = "Clearing the conversation only works in the omp terminal for now.";

function capabilityProvider(key: CapabilityKey): CapabilityStatus["via"] {
  if (key.startsWith("omp.")) return "omp";
  if (key.startsWith("host.")) return "host";
  if (key.startsWith("client.")) return "client";
  return "upstream";
}

/** Two real D5 commands the app can run, and one it cannot (clear), as in the running app. */
const capabilities: CapabilityMap = {};
for (const descriptor of DESCRIPTORS) {
  if (descriptor.id !== "D5.new" && descriptor.id !== "D5.fresh") continue;
  for (const key of descriptor.requires) {
    capabilities[key] = { state: "available", via: capabilityProvider(key) };
  }
}
const UNAVAILABLE_REASONS: ReadonlyMap<DescriptorId, string> = new Map([
  ["D5.clear", CLEAR_REASON],
]);

function PalettePlayground() {
  const [selectedCommand, setSelectedCommand] = useState<string | null>(null);
  const handlers = useMemo(
    () =>
      new Map<DescriptorId, CommandPaletteHandler>([
        ["D5.new", () => setSelectedCommand("New chat")],
        ["D5.fresh", () => setSelectedCommand("Refresh model connection")],
        ["D5.clear", () => setSelectedCommand("Clear conversation")],
      ]),
    [],
  );
  return (
    <RegistryProvider capabilities={capabilities} registry={registry} renderers={RENDERERS}>
      <ShortcutRegistryProvider
        descriptors={commandShortcutDescriptors}
        preferenceStore={new MemoryPreferenceStore()}
      >
        <OverlayHost>
          <main
            data-testid="u0-7-palette-playground"
            className="min-h-dvh bg-background p-(--space-2xl) text-foreground"
          >
            <div className="mx-auto flex max-w-2xl flex-col gap-(--space-lg)">
              <header className="flex flex-col gap-(--space-xs)">
                <h1 className="text-2xl font-semibold">Workspace commands</h1>
                <p className="text-muted-foreground text-sm">
                  Search available commands. Press Ctrl+K from the composer.
                </p>
              </header>
              <Textarea
                aria-label="Composer input"
                className="min-h-24 rounded-(--radius) border-border bg-background p-(--space-sm) text-base focus-visible:ring-ring"
                defaultValue="Review the latest changes"
              />
              <span
                aria-hidden="true"
                className="bg-popover sr-only"
                data-testid="popover-token-probe"
              >
                Palette surface token
              </span>
              {selectedCommand && (
                <p role="status" className="text-muted-foreground text-sm">
                  Selected: {selectedCommand}
                </p>
              )}
            </div>
          </main>
          <CommandPaletteHost handlers={handlers} unavailableReasons={UNAVAILABLE_REASONS} />
        </OverlayHost>
      </ShortcutRegistryProvider>
    </RegistryProvider>
  );
}

const root = document.getElementById("u0-7-palette-root");
if (root === null) throw new Error("The command palette playground root is missing.");
createRoot(root).render(<PalettePlayground />);
