import type { Descriptor, SettingDescriptor } from "@omp-app/contracts";

/**
 * I2's 24 inventory claims. The browser only advertises typed catalog, gateway and settings seams;
 * terminal-only plugin settings remain visibly gated until omp exposes an upstream capability.
 *
 * Omp facts are pinned to v18.9.1: marketplace command families are registered by
 * `packages/coding-agent/src/slash-commands/builtin-marketplace.ts:42-234,422-565`; the Skills
 * family is terminal-only in `builtin-skills.ts:66-100`; plugin settings are terminal-only in
 * `packages/tui/src/overlays/plugin-settings.ts`.
 */
export const I2_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "I2.extensions",
    owner: "I2",
    title: "Extensions",
    covers: ["C4.extensions"],
    requires: ["host.extension-catalog"],
  },
  {
    kind: "command",
    id: "I2.marketplace",
    owner: "I2",
    title: "Marketplace",
    covers: ["C4.marketplace"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "command",
    id: "I2.plugins",
    owner: "I2",
    title: "Plugins",
    covers: ["C4.plugins"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "command",
    id: "I2.reloadPlugins",
    owner: "I2",
    title: "Reload extensions",
    covers: ["C4.reload-plugins"],
    requires: ["host.command-gateway", "host.extension-catalog"],
  },
  {
    kind: "command",
    id: "I2.skills",
    owner: "I2",
    title: "Skills",
    covers: ["C4.skills"],
    requires: ["host.skills-registry"],
  },
  {
    kind: "command",
    id: "I2.skillsInstall",
    owner: "I2",
    title: "Install skills",
    covers: ["C4.skills-install"],
    requires: ["host.skills-registry"],
  },
  {
    kind: "command",
    id: "I2.skillsInstalled",
    owner: "I2",
    title: "Installed skills",
    covers: ["C4.skills-installed"],
    requires: ["host.extension-catalog"],
  },
  {
    kind: "command",
    id: "I2.skillsSearch",
    owner: "I2",
    title: "Search skills",
    covers: ["C4.skills-search"],
    requires: ["host.skills-registry"],
  },
  {
    kind: "command",
    id: "I2.skillsUpdate",
    owner: "I2",
    title: "Update skills",
    covers: ["C4.skills-update"],
    requires: ["host.skills-registry"],
  },
  {
    kind: "command",
    id: "I2.authGateway",
    owner: "I2",
    title: "Terminal sign-in gateway",
    covers: ["C4.auth-gateway-stdio"],
    requires: ["host.auth-gateway"],
  },
  {
    kind: "command",
    id: "I2.marketplaceAdd",
    owner: "I2",
    title: "Add marketplace",
    covers: ["C4.marketplace-add"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "command",
    id: "I2.marketplaceDiscover",
    owner: "I2",
    title: "Discover marketplace plugins",
    covers: ["C4.marketplace-discover"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "command",
    id: "I2.marketplaceHelp",
    owner: "I2",
    title: "Marketplace help",
    covers: ["C4.marketplace-help"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "command",
    id: "I2.marketplaceInstall",
    owner: "I2",
    title: "Install marketplace plugin",
    covers: ["C4.marketplace-install"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "command",
    id: "I2.marketplaceInstalled",
    owner: "I2",
    title: "Installed marketplace plugins",
    covers: ["C4.marketplace-installed"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "command",
    id: "I2.marketplaceList",
    owner: "I2",
    title: "List marketplaces",
    covers: ["C4.marketplace-list"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "command",
    id: "I2.marketplaceRemove",
    owner: "I2",
    title: "Remove marketplace",
    covers: ["C4.marketplace-remove"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "command",
    id: "I2.marketplaceUninstall",
    owner: "I2",
    title: "Uninstall marketplace plugin",
    covers: ["C4.marketplace-uninstall"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "command",
    id: "I2.marketplaceUpdate",
    owner: "I2",
    title: "Update marketplace",
    covers: ["C4.marketplace-update"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "command",
    id: "I2.marketplaceUpgrade",
    owner: "I2",
    title: "Upgrade marketplace plugins",
    covers: ["C4.marketplace-upgrade"],
    requires: ["host.command-gateway"],
  },
] as const satisfies readonly Descriptor[];

export const I2_PANEL_DESCRIPTORS = [
  {
    kind: "panel",
    id: "I2.extensionControlCenter",
    owner: "I2",
    title: "Extensions",
    covers: ["C4.extension-control-center"],
    requires: ["host.extension-catalog"],
  },
] as const satisfies readonly Descriptor[];

export const I2_DIALOG_DESCRIPTORS = [
  {
    kind: "dialog",
    id: "I2.pluginMarketplacePicker",
    owner: "I2",
    title: "Marketplace plugins",
    covers: ["C4.plugin-marketplace-picker"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "dialog",
    id: "I2.pluginSettings",
    owner: "I2",
    title: "Plugin settings",
    covers: ["S1.plugin-settings-panel"],
    requires: ["upstream.plugin-settings"],
  },
] as const satisfies readonly Descriptor[];

export const I2_SETTING_DESCRIPTORS = [
  {
    kind: "setting",
    id: "I2.interactionSkills",
    owner: "I2",
    title: "Skills",
    key: "skills.registryUrl",
    section: "interaction/Skills",
    covers: ["S3.interaction-skills"],
    requires: ["host.config"],
  },
] as const satisfies readonly SettingDescriptor[];

export const I2_DESCRIPTORS = [
  ...I2_COMMAND_DESCRIPTORS,
  ...I2_PANEL_DESCRIPTORS,
  ...I2_DIALOG_DESCRIPTORS,
  ...I2_SETTING_DESCRIPTORS,
] as const satisfies readonly Descriptor[];
