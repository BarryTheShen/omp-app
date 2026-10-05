import type {
  AppError,
  CapabilityKey,
  CapabilityMap,
  RedactedProviderAccount,
} from "@omp-app/contracts";
import {
  AppError as AppErrorSchema,
  CapabilityKey as CapabilityKeySchema,
  JsonValue as JsonValueSchema,
  RedactedProviderAccount as RedactedProviderAccountSchema,
  RedactedProvider as RedactedProviderSchema,
  SettingSource as SettingSourceSchema,
} from "@omp-app/contracts";
import { z } from "zod";

export const AUTH_CAPABILITIES = {
  getLoginProviders: "omp.cmd.get_login_providers",
  login: "omp.cmd.login",
  providerAccounts: "host.provider-accounts",
} as const satisfies Record<string, CapabilityKey>;

export const LoginProviderSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  available: z.boolean(),
  authenticated: z.boolean(),
});
export type LoginProvider = z.infer<typeof LoginProviderSchema>;

export const AuthStateSchema = z.enum([
  "idle",
  "loading",
  "waiting-for-browser",
  "waiting-for-callback",
  "authenticated",
  "cancelled",
  "error",
]);
export type AuthState = z.infer<typeof AuthStateSchema>;

export const AuthStatusSchema = z.strictObject({
  state: AuthStateSchema,
  providerId: z.string().min(1).optional(),
  error: AppErrorSchema.optional(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const ProfileSchema = z.strictObject({
  providerId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  active: z.boolean(),
  source: z.enum(["agent-db", "config", "env", "oauth"]),
  expiresAt: z.string().min(1).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const ProviderCatalogSchema = z.strictObject({
  providers: z.array(RedactedProviderSchema),
  revision: z.string().min(1).optional(),
});
export type ProviderCatalog = z.infer<typeof ProviderCatalogSchema>;

export const AccountSelectorStateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("loading"), providerId: z.string().min(1) }),
  z.strictObject({ state: z.literal("empty"), providerId: z.string().min(1) }),
  z.strictObject({
    state: z.literal("ready"),
    providerId: z.string().min(1),
    accounts: z.array(RedactedProviderAccountSchema),
    selectedAccountId: z.string().min(1).nullable(),
  }),
  z.strictObject({
    state: z.literal("error"),
    providerId: z.string().min(1),
    error: z.custom<AppError>(),
  }),
]);
export type AccountSelectorState = z.infer<typeof AccountSelectorStateSchema>;

export interface AccountSelector {
  readonly getState: () => AccountSelectorState;
  readonly select: (accountId: string) => void;
  readonly clear: () => void;
}

export interface AuthPort {
  readonly capabilities: () => CapabilityMap;
  readonly getLoginProviders: (options?: {
    readonly signal?: AbortSignal;
  }) => Promise<readonly LoginProvider[]>;
  readonly login: (
    providerId: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<AuthStatus>;
}

export interface ProviderCatalogPort {
  readonly capabilities: () => CapabilityMap;
  readonly listProviders: (options?: { readonly signal?: AbortSignal }) => Promise<ProviderCatalog>;
  readonly listAccounts: (
    providerId: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<readonly RedactedProviderAccount[]>;
}

export interface ProfilePort {
  readonly getCurrent: (options?: { readonly signal?: AbortSignal }) => Promise<Profile | null>;
  readonly subscribe: (listener: (profile: Profile | null) => void) => () => void;
}

export const ProviderSettingValueSchema = z.discriminatedUnion("secret", [
  z.strictObject({ secret: z.literal(false), value: JsonValueSchema }),
  z.strictObject({ secret: z.literal(true), set: z.boolean() }),
]);
export type ProviderSettingValue = z.infer<typeof ProviderSettingValueSchema>;

export const ProviderSettingsSectionSchema = z.strictObject({
  section: z.string().min(1),
  values: z.record(z.string(), ProviderSettingValueSchema),
  source: SettingSourceSchema,
  overrides: z.array(SettingSourceSchema),
  restartRequired: z.boolean(),
  capability: CapabilityKeySchema,
  validation: z.record(z.string(), z.string()).optional(),
});
export type ProviderSettingsSectionData = z.infer<typeof ProviderSettingsSectionSchema>;

export interface ProviderSettingsSection {
  readonly read: (options?: {
    readonly signal?: AbortSignal;
  }) => Promise<ProviderSettingsSectionData>;
  readonly write: (
    key: string,
    value: ProviderSettingValue,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<ProviderSettingsSectionData>;
}
