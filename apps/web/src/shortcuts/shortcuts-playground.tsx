import type { Descriptor } from "@omp-app/contracts";
import { createRoot } from "react-dom/client";
import { AppShell } from "@/shell";
import { ShortcutRegistryProvider, ShortcutSheetHost } from "./index";
import { MemoryPreferenceStore } from "./registry";

const DESCRIPTORS: readonly Descriptor[] = [
  {
    id: "U0.sheet",
    owner: "U0",
    title: "Shortcut sheet",
    kind: "shortcut",
    chord: "Mod+?",
    scope: "global",
    covers: [],
    requires: [],
  },
  {
    id: "U0.send",
    owner: "U0",
    title: "Send message",
    kind: "shortcut",
    chord: "Mod+Enter",
    scope: "composer",
    covers: [],
    requires: [],
  },
  {
    id: "U1.toggle",
    owner: "U1",
    title: "Toggle thinking",
    kind: "shortcut",
    chord: "Alt+T",
    scope: "transcript",
    covers: [],
    requires: [],
  },
  {
    id: "U5.todo",
    owner: "U5",
    title: "Toggle todo panel",
    kind: "shortcut",
    chord: "Alt+T",
    scope: "panel:todo",
    covers: [],
    requires: [],
  },
  {
    id: "U3.browser",
    owner: "U3",
    title: "Browser-owned example",
    kind: "shortcut",
    chord: "Mod+N",
    scope: "global",
    covers: [],
    requires: [],
  },
];

function ShortcutsPlayground() {
  return (
    <ShortcutRegistryProvider
      descriptors={DESCRIPTORS}
      preferenceStore={new MemoryPreferenceStore()}
    >
      <ShortcutSheetHost>
        <AppShell
          threadHeader={
            <div className="text-muted-foreground text-xs">Press ? or Mod+/ for shortcuts</div>
          }
          transcript={
            <div className="mx-auto w-full max-w-3xl px-6 py-12 text-sm">
              Shortcut sheet playground
            </div>
          }
        />
      </ShortcutSheetHost>
    </ShortcutRegistryProvider>
  );
}

const root = document.getElementById("shortcuts-playground-root");
if (!root) throw new Error("Shortcuts playground root is missing.");
createRoot(root).render(<ShortcutsPlayground />);
