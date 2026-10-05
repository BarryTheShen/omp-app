import { z } from "zod";
import { definePort } from "../../core/envelope";
import { ThreadId } from "../../core/ids";

/** Sources whose labels/ids may be shown without exposing credential material. */
export const ProviderAccountSource = z.enum(["agent-db", "config", "env", "oauth"]);
export type ProviderAccountSource = z.infer<typeof ProviderAccountSource>;

/** A provider credential kind, never the credential bytes themselves. */
export const ProviderCredentialKind = z.enum(["api_key", "oauth"]);
export type ProviderCredentialKind = z.infer<typeof ProviderCredentialKind>;

/** Provider discovery metadata safe for the browser and provider picker. */
export const RedactedProvider = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  available: z.boolean(),
  authenticated: z.boolean(),
  credentialKinds: z.array(ProviderCredentialKind).max(16),
  source: z.enum(["agent-db", "config", "env", "oauth", "none"]),
});
export type RedactedProvider = z.infer<typeof RedactedProvider>;

/** One stored account with only a stable opaque id and safe display metadata. */
export const RedactedProviderAccount = z.strictObject({
  id: z.string().min(1).max(128),
  providerId: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  active: z.boolean(),
  source: ProviderAccountSource,
  expiresAt: z.string().min(1).optional(),
});
export type RedactedProviderAccount = z.infer<typeof RedactedProviderAccount>;

export const ProviderListResult = z.strictObject({
  providers: z.array(RedactedProvider),
});
export type ProviderListResult = z.infer<typeof ProviderListResult>;

export const ProviderAccountsListArgs = z.strictObject({
  providerId: z.string().min(1).max(128),
  /** Optional current session used to mark its persisted OAuth affinity as active. */
  sessionId: ThreadId.optional(),
});
export type ProviderAccountsListArgs = z.infer<typeof ProviderAccountsListArgs>;

export const ProviderAccountsListResult = z.strictObject({
  providerId: z.string().min(1).max(128),
  accounts: z.array(RedactedProviderAccount),
});
export type ProviderAccountsListResult = z.infer<typeof ProviderAccountsListResult>;

export const ProviderAccountActionArgs = z.strictObject({
  providerId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128),
});
export type ProviderAccountActionArgs = z.infer<typeof ProviderAccountActionArgs>;

export const ProviderAccountLogoutResult = z.strictObject({
  providerId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128),
  removed: z.literal(true),
});
export type ProviderAccountLogoutResult = z.infer<typeof ProviderAccountLogoutResult>;

export const ProviderAccountPinArgs = z.strictObject({
  sessionId: ThreadId,
  providerId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128),
});
export type ProviderAccountPinArgs = z.infer<typeof ProviderAccountPinArgs>;

export const ProviderAccountPinResult = z.strictObject({
  sessionId: ThreadId,
  providerId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128),
  pinned: z.literal(true),
});
export type ProviderAccountPinResult = z.infer<typeof ProviderAccountPinResult>;

export const ProviderAccountResetResult = z.strictObject({
  providerId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128),
  reset: z.literal(true),
});
export type ProviderAccountResetResult = z.infer<typeof ProviderAccountResetResult>;

export const ProviderAccountStore = definePort({
  name: "A1.providerAccountStore",
  methods: {
    listProviders: {
      args: z.strictObject({}),
      result: ProviderListResult,
      capability: "host.provider-accounts",
    },
    listAccounts: {
      args: ProviderAccountsListArgs,
      result: ProviderAccountsListResult,
      capability: "host.provider-accounts",
    },
    logout: {
      args: ProviderAccountActionArgs,
      result: ProviderAccountLogoutResult,
      capability: "host.provider-accounts",
    },
    pin: {
      args: ProviderAccountPinArgs,
      result: ProviderAccountPinResult,
      capability: "host.provider-accounts",
    },
    resetUsage: {
      args: ProviderAccountActionArgs,
      result: ProviderAccountResetResult,
      capability: "host.provider-accounts",
    },
  },
  events: {},
});
