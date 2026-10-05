import {
  RedactedProviderAccount as RedactedProviderAccountSchema,
  RedactedProvider as RedactedProviderSchema,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  AccountSelectorStateSchema,
  AUTH_CAPABILITIES,
  AuthStatusSchema,
  LoginProviderSchema,
  ProfileSchema,
  ProviderCatalogSchema,
  ProviderSettingsSectionSchema,
  ProviderSettingValueSchema,
} from "./contract";

describe("D3 browser contracts", () => {
  test("accepts redacted provider/account DTOs and rejects secret-shaped fields", () => {
    expect(
      RedactedProviderSchema.safeParse({
        id: "openai-codex",
        name: "OpenAI Codex",
        available: true,
        authenticated: true,
        credentialKinds: ["oauth"],
        source: "oauth",
      }).success,
    ).toBe(true);
    expect(
      RedactedProviderAccountSchema.safeParse({
        id: "opaque-account-1",
        providerId: "openai-codex",
        label: "Work account",
        active: true,
        source: "oauth",
      }).success,
    ).toBe(true);
    for (const candidate of [
      {
        id: "provider",
        name: "Provider",
        available: true,
        authenticated: true,
        credentialKinds: [],
        source: "none",
        apiKey: "secret",
      },
      {
        id: "account",
        providerId: "provider",
        label: "Account",
        active: true,
        source: "oauth",
        accessToken: "secret",
      },
      {
        id: "account",
        providerId: "provider",
        label: "Account",
        active: true,
        source: "oauth",
        headers: { authorization: "secret" },
      },
    ]) {
      expect(RedactedProviderSchema.safeParse(candidate).success).toBe(false);
      expect(RedactedProviderAccountSchema.safeParse(candidate).success).toBe(false);
    }
  });

  test("catalog is read-only metadata and never accepts base URLs, passwords or headers", () => {
    const valid = {
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          available: true,
          authenticated: false,
          credentialKinds: ["api_key"],
          source: "none",
        },
      ],
    };
    expect(ProviderCatalogSchema.safeParse(valid).success).toBe(true);
    for (const key of ["baseUrl", "baseURL", "headers", "password", "token", "apiKey", "secret"]) {
      expect(ProviderCatalogSchema.safeParse({ ...valid, [key]: "secret-shaped" }).success).toBe(
        false,
      );
    }
  });

  test("auth/provider/profile schemas keep capability and lifecycle states typed", () => {
    expect(
      LoginProviderSchema.safeParse({
        id: "p",
        name: "Provider",
        available: true,
        authenticated: false,
      }).success,
    ).toBe(true);
    expect(
      AuthStatusSchema.safeParse({ state: "waiting-for-browser", providerId: "p" }).success,
    ).toBe(true);
    expect(
      ProfileSchema.safeParse({
        providerId: "p",
        accountId: "a",
        label: "Work",
        active: true,
        source: "oauth",
      }).success,
    ).toBe(true);
    expect(
      LoginProviderSchema.safeParse({
        id: "p",
        name: "P",
        available: true,
        authenticated: false,
        token: "secret",
      }).success,
    ).toBe(false);
    expect(AUTH_CAPABILITIES.getLoginProviders).toBe("omp.cmd.get_login_providers");
    expect(AUTH_CAPABILITIES.login).toBe("omp.cmd.login");
    expect(AUTH_CAPABILITIES.providerAccounts).toBe("host.provider-accounts");
  });

  test("account selector models loading/empty/ready/error without credential payloads", () => {
    expect(
      AccountSelectorStateSchema.safeParse({ state: "loading", providerId: "p" }).success,
    ).toBe(true);
    expect(AccountSelectorStateSchema.safeParse({ state: "empty", providerId: "p" }).success).toBe(
      true,
    );
    expect(
      AccountSelectorStateSchema.safeParse({
        state: "ready",
        providerId: "p",
        accounts: [{ id: "a", providerId: "p", label: "Work", active: true, source: "oauth" }],
        selectedAccountId: "a",
      }).success,
    ).toBe(true);
    expect(
      AccountSelectorStateSchema.safeParse({
        state: "ready",
        providerId: "p",
        accounts: [],
        selectedAccountId: null,
        token: "secret",
      }).success,
    ).toBe(false);
  });

  test("provider settings use a discriminant so secret values can never use value", () => {
    expect(ProviderSettingValueSchema.safeParse({ secret: false, value: "safe" }).success).toBe(
      true,
    );
    expect(ProviderSettingValueSchema.safeParse({ secret: true, set: true }).success).toBe(true);
    expect(ProviderSettingValueSchema.safeParse({ secret: true, value: "secret" }).success).toBe(
      false,
    );
    expect(
      ProviderSettingValueSchema.safeParse({ secret: false, value: "safe", token: "secret" })
        .success,
    ).toBe(false);
    expect(
      ProviderSettingsSectionSchema.safeParse({
        section: "providers/Protocol",
        values: { endpoint: { secret: false, value: "default" }, key: { secret: true, set: true } },
        source: "project",
        overrides: ["global"],
        restartRequired: false,
        capability: "host.config-store",
      }).success,
    ).toBe(true);
  });
});
