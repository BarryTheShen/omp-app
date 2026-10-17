import type { Descriptor, SettingDescriptor } from "@omp-app/contracts";
import type { SettingsSectionDescriptor } from "../../S1/settings-kit";
import { MEMORY_COMMAND_DESCRIPTORS } from "../memory/commands";
import { MEMORY_SETTINGS_SECTIONS } from "../settings/descriptors";

/** The rules browser is an app-only surface; omp has no standalone rules command row. */
export const I3_RULES_DESCRIPTOR = {
  kind: "panel",
  id: "I3.rules",
  owner: "I3",
  title: "Rules",
  covers: [],
  requires: ["host.rules"],
} as const satisfies Descriptor;

function settingDescriptor(section: SettingsSectionDescriptor): SettingDescriptor {
  const representative = section.controls[0];
  if (!representative) {
    throw new Error(`I3 settings section ${section.id} has no registered controls.`);
  }
  return {
    kind: "setting",
    id: section.id,
    owner: "I3",
    title: section.title,
    covers: [...section.inventory],
    requires: [...section.requires],
    key: representative.key,
    section: section.section,
  };
}

export const I3_SETTINGS_DESCRIPTORS = MEMORY_SETTINGS_SECTIONS.map(settingDescriptor);

/** One claim for each of I3's fifteen memory rows, five settings groups, and app-only rules panel. */
export const I3_DESCRIPTORS = [
  ...MEMORY_COMMAND_DESCRIPTORS,
  ...I3_SETTINGS_DESCRIPTORS,
  I3_RULES_DESCRIPTOR,
] as const satisfies readonly Descriptor[];

export type I3Descriptor = (typeof I3_DESCRIPTORS)[number];
