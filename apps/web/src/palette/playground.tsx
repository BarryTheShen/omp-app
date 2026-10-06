import type {
  CapabilityKey,
  CapabilityMap,
  CapabilityStatus,
  CommandDescriptor,
} from "@omp-app/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Textarea } from "@/components/ui/textarea";
import { OverlayHost } from "@/overlay";
import { DESCRIPTORS, RENDERERS, registry } from "@/registry";
import { RegistryProvider } from "@/registry-core";
import { MemoryPreferenceStore, ShortcutRegistryProvider } from "@/shortcuts";
import { CommandPaletteHost, U0_COMMAND_PALETTE_SHORTCUT } from "./index";

const commandShortcutDescriptors = [
  ...DESCRIPTORS.filter((descriptor) => descriptor.id !== U0_COMMAND_PALETTE_SHORTCUT.id),
  U0_COMMAND_PALETTE_SHORTCUT,
];

const firstGatedCommand = DESCRIPTORS.find(
  (descriptor): descriptor is CommandDescriptor =>
    descriptor.kind === "command" && descriptor.requires.length > 0,
);

function capabilityProvider(key: CapabilityKey): CapabilityStatus["via"] {
  if (key.startsWith("omp.")) return "rpc";
  if (key.startsWith("host.")) return "host";
  if (key.startsWith("client.")) return "client";
  return "upstream";
}

const capabilities: CapabilityMap = {};
for (const key of firstGatedCommand?.requires ?? []) {
  capabilities[key] = { state: "available", via: capabilityProvider(key) };
}

function PalettePlayground() {
  const [selectedCommand, setSelectedCommand] = useState<string | null>(null);
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
                  Search the app's registered commands. Press Ctrl+K from the composer.
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
          <CommandPaletteHost onCommandSelect={(command) => setSelectedCommand(command.title)} />
        </OverlayHost>
      </ShortcutRegistryProvider>
    </RegistryProvider>
  );
}

const root = document.getElementById("u0-7-palette-root");
if (root === null) throw new Error("The command palette playground root is missing.");
createRoot(root).render(<PalettePlayground />);
