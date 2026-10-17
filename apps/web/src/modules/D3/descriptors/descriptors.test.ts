import { Descriptor, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { D3_CATALOG_DESCRIPTORS, D3_DESCRIPTORS, D3_SETTING_DESCRIPTORS } from "./descriptors";

describe("D3.6 descriptors", () => {
  test("covers exactly D3's 14 inventory rows without Services or switch", () => {
    const covers = D3_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect(D3_DESCRIPTORS).toHaveLength(14);
    expect(new Set(covers).size).toBe(14);
    expect(covers).toEqual([
      "D4.login",
      "D4.logout",
      "D4.oauth-provider-selector",
      "D4.login-dialog",
      "D4.logout-account-selector",
      "D4.reset-usage-account-selector",
      "C1.setup",
      "C1.setup-providers",
      "C1.setup-wizard",
      "S5.providers-fireworks",
      "S5.providers-tiny-model",
      "S5.providers-protocol",
      "S5.providers-timeouts",
      "S5.providers-privacy",
    ]);
    expect(covers).not.toContain("D4.switch");
    expect(covers).not.toContain("S5.providers-services");
  });
  test("passes the shared registry validation", () => {
    expect(validateRegistry(D3_DESCRIPTORS)).toEqual([]);
  });

  test("requires every exact capability for each catalog descriptor", () => {
    const requires = Object.fromEntries(
      D3_CATALOG_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor.requires]),
    );
    expect(requires).toEqual({
      "D3.login": ["omp.cmd.get_login_providers", "omp.cmd.login"],
      "D3.logout": ["host.provider-accounts"],
      "D3.oauthProviderSelector": [
        "omp.ui",
        "omp.cmd.get_login_providers",
        "host.provider-accounts",
      ],
      "D3.loginDialog": ["omp.ui", "omp.cmd.login"],
      "D3.logoutAccountSelector": ["omp.ui", "host.provider-accounts"],
      "D3.resetUsageAccountSelector": ["omp.ui", "host.provider-accounts"],
      "D3.setup": ["host.command-gateway", "upstream.provider-setup-commands"],
      "D3.setupProviders": ["host.command-gateway", "upstream.provider-setup-commands"],
      "D3.setupWizard": ["omp.ui", "upstream.setup-wizard"],
    });
  });

  test("each descriptor parses through the shared contract and claims only D3", () => {
    for (const descriptor of D3_DESCRIPTORS) {
      expect(Descriptor.safeParse(descriptor).success).toBe(true);
      expect(descriptor.owner).toBe("D3");
    }
    expect(D3_CATALOG_DESCRIPTORS.find((descriptor) => descriptor.id === "D3.login")).toMatchObject(
      {
        kind: "command",
        slash: { name: "login", source: "builtin" },
      },
    );
    expect(
      D3_CATALOG_DESCRIPTORS.find((descriptor) => descriptor.id === "D3.logout"),
    ).toMatchObject({
      kind: "command",
      slash: { name: "logout", source: "builtin" },
    });
    expect(D3_CATALOG_DESCRIPTORS.find((descriptor) => descriptor.id === "D3.setup")).toMatchObject(
      {
        kind: "command",
        slash: { name: "setup", source: "builtin" },
      },
    );
  });

  test("setting descriptors hand off the five C0 provider sections", () => {
    expect(
      D3_SETTING_DESCRIPTORS.map((descriptor) => [descriptor.section, descriptor.key]),
    ).toEqual([
      ["providers/Fireworks", "providers.fireworksTier"],
      ["providers/Tiny Model", "providers.tinyModelDevice"],
      ["providers/Protocol", "providers.kimiApiFormat"],
      ["providers/Timeouts", "providers.streamFirstEventTimeoutSeconds"],
      ["providers/Privacy", "secrets.enabled"],
    ]);
    expect(
      D3_SETTING_DESCRIPTORS.every((descriptor) => descriptor.requires.includes("host.config")),
    ).toBe(true);
  });
});
