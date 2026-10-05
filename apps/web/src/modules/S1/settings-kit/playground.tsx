import { useMemo, useState } from "react";
import type {
  ConfigSnapshot,
  SettingControl,
  SettingsSectionDescriptor,
  StagedSettings,
} from "./grammar";
import { SettingsSection } from "./section";

const controls: readonly SettingControl[] = [
  {
    key: "appearance.theme",
    label: "Theme",
    description: "Preview a light, dark or system surface before saving.",
    kind: "enum",
    secret: false,
    options: [
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
    validate: () => ({ valid: true }),
    apply: "live",
  },
  {
    key: "appearance.showInlineImages",
    label: "Show inline images",
    description: "Render safe image parts in the transcript.",
    kind: "boolean",
    secret: false,
    validate: () => ({ valid: true }),
    apply: "live",
  },
  {
    key: "appearance.scrollbackLines",
    label: "Scrollback lines",
    description: "Keep more history available when the transcript grows.",
    kind: "number",
    secret: false,
    validate: (value) =>
      value.secret || typeof value.value !== "number" || value.value < 0
        ? { valid: false, code: "range", message: "Use a non-negative number of lines." }
        : { valid: true },
    apply: "reload",
  },
  {
    key: "provider.apiKey",
    label: "Provider API key",
    description: "The value is write-only; this kit exposes only set/unset and provenance.",
    kind: "secret",
    secret: true,
    validate: () => ({ valid: true }),
    apply: "restart",
  },
];

export const settingsKitPlaygroundDescriptor: SettingsSectionDescriptor = {
  id: "S1.settingsKitPlayground",
  section: "appearance/Theme",
  title: "Appearance",
  inventory: [],
  controls,
  requires: [],
};

export function SettingsKitPlayground() {
  const snapshot = useMemo<ConfigSnapshot>(
    () => ({
      folder: null,
      revision: "playground-revision",
      entries: [
        {
          key: "appearance.theme",
          secret: false,
          value: "system",
          source: "default",
          overrides: [],
        },
        {
          key: "appearance.showInlineImages",
          secret: false,
          value: true,
          source: "project",
          overrides: ["global", "default"],
        },
        {
          key: "appearance.scrollbackLines",
          secret: false,
          value: 5000,
          source: "global",
          overrides: ["default"],
        },
        {
          key: "provider.apiKey",
          secret: true,
          isSet: true,
          source: "global",
          overrides: [],
        },
      ],
    }),
    [],
  );
  const [staged, setStaged] = useState<StagedSettings>({ snapshot, edits: {} });
  const [secretAction, setSecretAction] = useState<string>("");
  const [saved, setSaved] = useState(false);

  return (
    <main className="bg-background text-foreground min-h-screen p-6 sm:p-10">
      <div className="mx-auto max-w-3xl">
        <SettingsSection
          descriptor={settingsKitPlaygroundDescriptor}
          snapshot={snapshot}
          staged={staged}
          applyStatus={saved ? "Saved · live preview" : secretAction || undefined}
          onStage={setStaged}
          onSecretAction={(key, action) => setSecretAction(`${key}: ${action}`)}
          onCommit={() => setSaved(true)}
          onCancel={() => {
            setStaged({ snapshot, edits: {} });
            setSaved(false);
          }}
        />
      </div>
    </main>
  );
}
