import type {
  CapabilityKey,
  CommandDescriptor,
  DialogDescriptor,
  SettingDescriptor,
} from "@omp-app/contracts";
import { AUTH_CAPABILITIES } from "../contract";
import { SETUP_CAPABILITIES } from "../setup/setup";

const UI = "omp.ui" as const;
const CONFIG = "host.config" as const;
const ACCOUNTS = AUTH_CAPABILITIES.providerAccounts;

const command = (
  id: string,
  title: string,
  covers: readonly string[],
  requires: readonly CapabilityKey[],
  slash?: string,
): CommandDescriptor => ({
  kind: "command",
  id: id as CommandDescriptor["id"],
  owner: "D3",
  title,
  covers: [...covers] as CommandDescriptor["covers"],
  requires: [...requires],
  ...(slash === undefined ? {} : { slash: { name: slash, source: "builtin" as const } }),
});

const dialog = (
  id: string,
  title: string,
  covers: readonly string[],
  requires: readonly CapabilityKey[],
): DialogDescriptor => ({
  kind: "dialog",
  id: id as DialogDescriptor["id"],
  owner: "D3",
  title,
  covers: [...covers] as DialogDescriptor["covers"],
  requires: [...requires],
});

const setting = (
  id: string,
  title: string,
  key: string,
  section: SettingDescriptor["section"],
  cover: string,
): SettingDescriptor => ({
  kind: "setting",
  id: id as SettingDescriptor["id"],
  owner: "D3",
  title,
  covers: [cover] as SettingDescriptor["covers"],
  requires: [CONFIG],
  key,
  section,
});

export const D3_CATALOG_DESCRIPTORS = [
  command(
    "D3.login",
    "Provider login",
    ["D4.login"],
    [AUTH_CAPABILITIES.getLoginProviders, AUTH_CAPABILITIES.login],
    "login",
  ),
  command("D3.logout", "Provider logout", ["D4.logout"], [ACCOUNTS], "logout"),
  dialog(
    "D3.oauthProviderSelector",
    "Provider selector",
    ["D4.oauth-provider-selector"],
    [UI, AUTH_CAPABILITIES.getLoginProviders, ACCOUNTS],
  ),
  dialog("D3.loginDialog", "Provider login", ["D4.login-dialog"], [UI, AUTH_CAPABILITIES.login]),
  dialog(
    "D3.logoutAccountSelector",
    "Provider account selector",
    ["D4.logout-account-selector"],
    [UI, ACCOUNTS],
  ),
  dialog(
    "D3.resetUsageAccountSelector",
    "Provider usage reset",
    ["D4.reset-usage-account-selector"],
    [UI, ACCOUNTS],
  ),
  command(
    "D3.setup",
    "Provider setup",
    ["C1.setup"],
    [SETUP_CAPABILITIES.commandGateway, SETUP_CAPABILITIES.setupCommands],
    "setup",
  ),
  command(
    "D3.setupProviders",
    "Provider setup",
    ["C1.setup-providers"],
    [SETUP_CAPABILITIES.commandGateway, SETUP_CAPABILITIES.setupCommands],
  ),
  dialog(
    "D3.setupWizard",
    "Provider setup wizard",
    ["C1.setup-wizard"],
    [UI, SETUP_CAPABILITIES.wizard],
  ),
] as const;

export const D3_SETTING_DESCRIPTORS = [
  setting(
    "D3.providerFireworks",
    "Fireworks",
    "providers.fireworksTier",
    "providers/Fireworks",
    "S5.providers-fireworks",
  ),
  setting(
    "D3.providerTinyModel",
    "Tiny model",
    "providers.tinyModelDevice",
    "providers/Tiny Model",
    "S5.providers-tiny-model",
  ),
  setting(
    "D3.providerProtocol",
    "Protocol",
    "providers.kimiApiFormat",
    "providers/Protocol",
    "S5.providers-protocol",
  ),
  setting(
    "D3.providerTimeouts",
    "Timeouts",
    "providers.streamFirstEventTimeoutSeconds",
    "providers/Timeouts",
    "S5.providers-timeouts",
  ),
  setting(
    "D3.providerPrivacy",
    "Privacy",
    "secrets.enabled",
    "providers/Privacy",
    "S5.providers-privacy",
  ),
] as const;

export const D3_DESCRIPTORS = [...D3_CATALOG_DESCRIPTORS, ...D3_SETTING_DESCRIPTORS] as const;
export type D3Descriptor = (typeof D3_DESCRIPTORS)[number];
