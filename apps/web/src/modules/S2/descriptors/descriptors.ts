import type { SettingDescriptor } from "@omp-app/contracts";
import type { SettingsSectionDescriptor } from "../../S1/settings-kit";
import { S2_SETTINGS_SECTIONS } from "../sections";

function settingDescriptor(section: SettingsSectionDescriptor): SettingDescriptor {
  // C0 records one key per group; the exported S1.1 section retains the complete control list.
  const representative = section.controls[0];
  if (!representative) {
    throw new Error(`S2 settings section ${section.id} has no registered controls.`);
  }
  return {
    id: section.id,
    owner: "S2",
    title: section.title,
    kind: "setting",
    covers: [...section.inventory],
    requires: [...section.requires],
    key: representative.key,
    section: section.section,
  };
}

/** C0 registry claims for S2's six Files and Shell settings groups; each claim mirrors one S1.1 section. */
export const S2_DESCRIPTORS: readonly SettingDescriptor[] = Object.freeze(
  S2_SETTINGS_SECTIONS.map(settingDescriptor),
);
