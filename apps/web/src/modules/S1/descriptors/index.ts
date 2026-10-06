import type { Descriptor, SettingDescriptor } from "@omp-app/contracts";
import { S1_APPEARANCE_SECTIONS } from "../appearance";
import { S1_INTERACTION_SECTIONS } from "../interaction";
import type { SettingsSectionDescriptor } from "../settings-kit";

/** S1.1/S1.2 section definitions reused by the registry and settings-surface consumers. */
export const S1_SETTINGS_SECTIONS: readonly SettingsSectionDescriptor[] = [
  ...S1_APPEARANCE_SECTIONS,
  ...S1_INTERACTION_SECTIONS,
];

const SETTINGS_SURFACE_DESCRIPTORS = [
  {
    kind: "command",
    id: "S1.settings",
    owner: "S1",
    title: "Settings",
    covers: ["S1.settings"],
    requires: ["host.config"],
  },
  {
    kind: "dialog",
    id: "S1.settingsSelector",
    owner: "S1",
    title: "Settings selector",
    covers: ["S1.settings-selector"],
    requires: ["host.config"],
  },
  {
    kind: "dialog",
    id: "S1.themeSelector",
    owner: "S1",
    title: "Theme selector",
    covers: ["S1.theme-selector"],
    requires: ["host.config"],
  },
  {
    kind: "dialog",
    id: "S1.showImagesSelector",
    owner: "S1",
    title: "Show images selector",
    covers: ["S1.show-images-selector"],
    requires: ["host.config"],
  },
] as const satisfies readonly Descriptor[];

function settingDescriptor(section: SettingsSectionDescriptor): SettingDescriptor {
  const representative = section.controls[0];
  if (!representative) throw new Error(`S1 setting section ${section.id} has no controls.`);
  const [tab] = section.section.split("/");
  const tabTitle = tab === "appearance" ? "Appearance" : "Interaction";
  return {
    kind: "setting",
    id: section.id,
    owner: "S1",
    title: `${tabTitle} / ${section.title} settings`,
    covers: [...section.inventory],
    requires: [...section.requires],
    key: representative.key,
    section: section.section,
  };
}

/** One C0 setting descriptor per S1-owned `<tab>/<section>` namespace. */
export const S1_SETTING_DESCRIPTORS: readonly SettingDescriptor[] =
  S1_SETTINGS_SECTIONS.map(settingDescriptor);

/** S1-owned app command, selector dialogs and 14 typed settings-section claims. */
export const S1_DESCRIPTORS: readonly Descriptor[] = [
  ...SETTINGS_SURFACE_DESCRIPTORS,
  ...S1_SETTING_DESCRIPTORS,
];
