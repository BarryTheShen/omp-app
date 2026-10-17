import {
  RedactedProviderAccount as RedactedProviderAccountSchema,
  RedactedProvider as RedactedProviderSchema,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { ProfileSchema, ProviderCatalogSchema, ProviderSettingValueSchema } from "../contract";

function secretFixture() {
  return {
    access: ["Bearer", "t".repeat(32)].join(" "),
    refresh: ["refresh", "r".repeat(32)].join("-"),
    email: ["person", "example.test"].join("@"),
    apiKey: ["sk", "ant", "k".repeat(30)].join("-"),
  };
}

describe("D3 redaction/security gate", () => {
  test("rejects secret-bearing provider/account payloads and accepts a redacted DTO", () => {
    const fixture = secretFixture();
    const providerWithSecrets = {
      id: "provider-a",
      name: "Provider A",
      available: true,
      authenticated: true,
      credentialKinds: ["oauth"],
      source: "agent-db",
      access: fixture.access,
      refresh: fixture.refresh,
      apiKey: fixture.apiKey,
      password: fixture.apiKey,
      headers: { authorization: fixture.access },
    };
    const accountWithSecrets = {
      id: "acct-opaque",
      providerId: "provider-a",
      label: fixture.email,
      active: true,
      source: "oauth",
      access_token: fixture.access,
      refresh_token: fixture.refresh,
      password: fixture.apiKey,
      headers: { authorization: fixture.access },
    };
    expect(RedactedProviderSchema.safeParse(providerWithSecrets).success).toBe(false);
    expect(RedactedProviderAccountSchema.safeParse(accountWithSecrets).success).toBe(false);
    expect(ProviderCatalogSchema.safeParse({ providers: [providerWithSecrets] }).success).toBe(
      false,
    );
    expect(
      ProfileSchema.safeParse({
        providerId: "provider-a",
        accountId: "acct-opaque",
        label: fixture.email,
        active: true,
        source: "oauth",
        access_token: fixture.access,
      }).success,
    ).toBe(false);

    const redacted = {
      id: "acct-opaque",
      providerId: "provider-a",
      label: "p***@example.test",
      active: true,
      source: "oauth" as const,
    };
    expect(RedactedProviderAccountSchema.safeParse(redacted).success).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain(fixture.access);
    expect(JSON.stringify(redacted)).not.toContain(fixture.email);
  });

  test("secret setting values use the set/unset status and cannot carry a value", () => {
    expect(ProviderSettingValueSchema.safeParse({ secret: true, set: true }).success).toBe(true);
    expect(
      ProviderSettingValueSchema.safeParse({ secret: true, set: true, value: "hidden" }).success,
    ).toBe(false);
    expect(ProviderSettingValueSchema.safeParse({ secret: false, value: "safe" }).success).toBe(
      true,
    );
  });
});
