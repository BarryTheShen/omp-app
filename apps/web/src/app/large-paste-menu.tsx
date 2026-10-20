import type { AppClient } from "@omp-app/client";
import type { FolderPath } from "@omp-app/contracts";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { INPUT_SETTINGS_SECTION } from "@/modules/S1/interaction";
import { createSettingsRuntime, type SettingsRuntimeSnapshot } from "@/modules/S1/runtime";
import { DEFAULT_LARGE_PASTE_LINE_THRESHOLD } from "@/modules/U2/attachments";
import { LargePasteMenuThresholdContext } from "@/modules/U2/composer";
import type { SettingsClosedSignal } from "./settings-closed-signal";

/** omp's key for Settings > Interaction > Large Paste Menu. */
const LARGE_PASTE_MENU_KEY = "paste.largeMenuThreshold";

/** The threshold the saved setting gives, or omp's default while there is no saved value to read. */
export function largePasteThresholdOf(config: SettingsRuntimeSnapshot["config"]): number {
  const entry = config?.entries.find((candidate) => candidate.key === LARGE_PASTE_MENU_KEY);
  if (entry === undefined || entry.secret || typeof entry.value !== "number") {
    return DEFAULT_LARGE_PASTE_LINE_THRESHOLD;
  }
  return entry.value;
}

/**
 * Provides the Large Paste Menu threshold to every composer beneath it: the value omp uses for the open workspace (the
 * workspace's own value, or the global one when it has none). It is read when the workspace changes and each time the
 * Settings screen closes: that screen saves through its own runtime, and the save does not reach this one.
 */
export function LargePasteMenuProvider({
  client,
  folder,
  settingsClosed,
  children,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath | null;
  readonly settingsClosed: SettingsClosedSignal;
  readonly children: ReactNode;
}) {
  const [threshold, setThreshold] = useState(DEFAULT_LARGE_PASTE_LINE_THRESHOLD);
  const settingsClosedCount = useSyncExternalStore(
    settingsClosed.subscribe,
    settingsClosed.count,
    settingsClosed.count,
  );
  return (
    <LargePasteMenuThresholdContext.Provider value={threshold}>
      <ThresholdReader
        key={settingsClosedCount}
        client={client}
        folder={folder}
        onThreshold={setThreshold}
      />
      {children}
    </LargePasteMenuThresholdContext.Provider>
  );
}

/** Tells `onThreshold` the threshold of the open workspace while it is mounted. It renders nothing. */
function ThresholdReader({
  client,
  folder,
  onThreshold,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath | null;
  readonly onThreshold: (threshold: number) => void;
}) {
  useEffect(() => {
    // The runtime is made here, not kept across renders: a disposed runtime stays disposed.
    const runtime = createSettingsRuntime(client, {
      descriptor: INPUT_SETTINGS_SECTION,
      folder,
      layer: "project",
    });
    // Until a config is read, the threshold on screen stays: a snapshot without one is loading or failed.
    const unsubscribe = runtime.subscribe((snapshot: SettingsRuntimeSnapshot) => {
      if (snapshot.config !== null) onThreshold(largePasteThresholdOf(snapshot.config));
    });
    // A failed read keeps the threshold on screen; the next close or change reads again.
    void runtime.read().catch(() => undefined);
    return () => {
      unsubscribe();
      runtime.dispose();
    };
  }, [client, folder, onThreshold]);
  return null;
}
