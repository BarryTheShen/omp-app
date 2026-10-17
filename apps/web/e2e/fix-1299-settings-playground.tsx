import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ConfigSnapshot,
  SettingControl,
  SettingsSectionDescriptor,
  StagedSettings,
} from "@/modules/S1/settings-kit";
import { SettingsSection } from "@/modules/S1/settings-kit";

const controls: readonly SettingControl[] = [
  {
    key: "review.alwaysOn",
    label: "Always on",
    kind: "boolean",
    secret: false,
    validate: (candidate) =>
      !candidate.secret && typeof candidate.value === "boolean"
        ? { valid: true }
        : { valid: false, code: "boolean", message: "Choose On or Off." },
    apply: "live",
  },
  {
    key: "review.theme",
    label: "Theme",
    kind: "enum",
    secret: false,
    options: [
      { value: "system", label: "System" },
      { value: "dark", label: "Dark" },
    ],
    validate: (candidate) =>
      !candidate.secret && (candidate.value === "system" || candidate.value === "dark")
        ? { valid: true }
        : { valid: false, code: "enum", message: "Choose a supported theme." },
    apply: "live",
  },
  {
    key: "review.agentModes",
    label: "Agent overrides",
    kind: "map",
    secret: false,
    keyLabel: "Agent name",
    value: { label: "Enabled", kind: "boolean" },
    addLabel: "Add agent",
    emptyLabel: "No agent overrides",
    validate: () => ({ valid: true }),
    apply: "live",
  },
];

const descriptor: SettingsSectionDescriptor = {
  id: "S1.issue1299Screenshot" as never,
  section: "appearance/Theme" as never,
  title: "Settings recovery",
  inventory: [],
  controls,
  requires: [],
};

const snapshot: ConfigSnapshot = {
  folder: null,
  revision: "review" as never,
  entries: [
    { key: "review.alwaysOn", secret: false, value: "yes", source: "global", overrides: [] },
    { key: "review.theme", secret: false, value: "bogus", source: "global", overrides: [] },
    {
      key: "review.agentModes",
      secret: false,
      value: { builder: "yes" },
      source: "global",
      overrides: [],
    },
  ],
};

function SettingsRecoveryPlayground() {
  const [staged, setStaged] = useState<StagedSettings>({ snapshot, edits: {} });
  return (
    <main className="bg-background text-foreground min-h-dvh p-6 sm:p-10">
      <div className="mx-auto max-w-3xl">
        <SettingsSection
          descriptor={descriptor}
          snapshot={snapshot}
          staged={staged}
          onStage={setStaged}
        />
      </div>
    </main>
  );
}

const root = document.getElementById("settings-recovery-root");
if (!root) throw new Error("The settings recovery root is missing.");
createRoot(root).render(<SettingsRecoveryPlayground />);
