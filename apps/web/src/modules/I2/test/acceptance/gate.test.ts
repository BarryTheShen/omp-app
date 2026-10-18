import type { AppClient } from "@omp-app/client";
import {
  type CapabilityKey,
  CapabilityMap,
  checkScrubbed,
  OmpCommandGateway as OmpCommandGatewayPort,
  ThreadId,
  validateRegistry,
} from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { DESCRIPTORS } from "@/registry";
import { createRegistry } from "@/registry-core";
import {
  capabilityStatus,
  isDescriptorAvailable,
  UPSTREAM_UNAVAILABLE,
} from "@/registry-core/hooks";
import { normalizeCatalog } from "../../catalog/contract";
import { createMarketplacePort } from "../../catalog/marketplace";
import {
  I2_DESCRIPTORS,
  I2_DIALOG_DESCRIPTORS,
  I2_PANEL_DESCRIPTORS,
  I2_SETTING_DESCRIPTORS,
} from "../../descriptors";
import {
  I2_CATALOG_FIXTURE,
  I2_CONFIG_LIST_FIXTURE,
  I2_FIXTURE_HEADER,
  I2_GATEWAY_FIXTURE,
  I2_INVENTORY_ROWS,
} from "../../fixtures";

const EXPECTED_I2_ROWS = [
  "C4.extensions",
  "C4.marketplace",
  "C4.plugins",
  "C4.reload-plugins",
  "C4.skills",
  "C4.skills-install",
  "C4.skills-installed",
  "C4.skills-search",
  "C4.skills-update",
  "C4.auth-gateway-stdio",
  "C4.marketplace-add",
  "C4.marketplace-discover",
  "C4.marketplace-help",
  "C4.marketplace-install",
  "C4.marketplace-installed",
  "C4.marketplace-list",
  "C4.marketplace-remove",
  "C4.marketplace-uninstall",
  "C4.marketplace-update",
  "C4.marketplace-upgrade",
  "C4.extension-control-center",
  "C4.plugin-marketplace-picker",
  "S1.plugin-settings-panel",
  "S3.interaction-skills",
] as const;

const sorted = (values: readonly string[]): string[] => [...values].sort();

function fakeGatewayClient(run: ReturnType<typeof vi.fn>): AppClient {
  return {
    port(port: unknown) {
      if (port === OmpCommandGatewayPort) return { run };
      throw new Error("unexpected port");
    },
  } as unknown as AppClient;
}

const expectedCapabilityTable: Readonly<
  Record<string, { readonly covers: readonly string[]; readonly requires: readonly string[] }>
> = {
  "I2.extensions": { covers: ["C4.extensions"], requires: ["host.extension-catalog"] },
  "I2.marketplace": { covers: ["C4.marketplace"], requires: ["host.command-gateway"] },
  "I2.plugins": { covers: ["C4.plugins"], requires: ["host.command-gateway"] },
  "I2.reloadPlugins": {
    covers: ["C4.reload-plugins"],
    requires: ["host.command-gateway", "host.extension-catalog"],
  },
  "I2.skills": { covers: ["C4.skills"], requires: ["host.skills-registry"] },
  "I2.skillsInstall": { covers: ["C4.skills-install"], requires: ["host.skills-registry"] },
  "I2.skillsInstalled": {
    covers: ["C4.skills-installed"],
    requires: ["host.extension-catalog"],
  },
  "I2.skillsSearch": { covers: ["C4.skills-search"], requires: ["host.skills-registry"] },
  "I2.skillsUpdate": { covers: ["C4.skills-update"], requires: ["host.skills-registry"] },
  "I2.authGateway": { covers: ["C4.auth-gateway-stdio"], requires: ["host.auth-gateway"] },
  "I2.marketplaceAdd": {
    covers: ["C4.marketplace-add"],
    requires: ["host.command-gateway"],
  },
  "I2.marketplaceDiscover": {
    covers: ["C4.marketplace-discover"],
    requires: ["host.command-gateway"],
  },
  "I2.marketplaceHelp": {
    covers: ["C4.marketplace-help"],
    requires: ["host.command-gateway"],
  },
  "I2.marketplaceInstall": {
    covers: ["C4.marketplace-install"],
    requires: ["host.command-gateway"],
  },
  "I2.marketplaceInstalled": {
    covers: ["C4.marketplace-installed"],
    requires: ["host.command-gateway"],
  },
  "I2.marketplaceList": {
    covers: ["C4.marketplace-list"],
    requires: ["host.command-gateway"],
  },
  "I2.marketplaceRemove": {
    covers: ["C4.marketplace-remove"],
    requires: ["host.command-gateway"],
  },
  "I2.marketplaceUninstall": {
    covers: ["C4.marketplace-uninstall"],
    requires: ["host.command-gateway"],
  },
  "I2.marketplaceUpdate": {
    covers: ["C4.marketplace-update"],
    requires: ["host.command-gateway"],
  },
  "I2.marketplaceUpgrade": {
    covers: ["C4.marketplace-upgrade"],
    requires: ["host.command-gateway"],
  },
  "I2.extensionControlCenter": {
    covers: ["C4.extension-control-center"],
    requires: ["host.extension-catalog"],
  },
  "I2.pluginMarketplacePicker": {
    covers: ["C4.plugin-marketplace-picker"],
    requires: ["host.command-gateway"],
  },
  "I2.pluginSettings": {
    covers: ["S1.plugin-settings-panel"],
    requires: ["upstream.plugin-settings"],
  },
  "I2.interactionSkills": {
    covers: ["S3.interaction-skills"],
    requires: ["host.config"],
  },
};

describe("I2 descriptors and CC12 gate", () => {
  test("claims exactly the 24 I2 inventory rows and no C0 row twice", () => {
    const descriptorRows = I2_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect(sorted(descriptorRows)).toEqual(sorted(EXPECTED_I2_ROWS));
    expect(new Set(descriptorRows).size).toBe(descriptorRows.length);
    expect(sorted(I2_INVENTORY_ROWS)).toEqual(sorted(EXPECTED_I2_ROWS));
    expect(sorted(I2_FIXTURE_HEADER.inventory)).toEqual(sorted(EXPECTED_I2_ROWS));
    expect(I2_DESCRIPTORS).toHaveLength(24);
    expect(validateRegistry(I2_DESCRIPTORS)).toEqual([]);
  });
  test("composes I2 with the app registry without a second claim", () => {
    const registry = createRegistry([...DESCRIPTORS, ...I2_DESCRIPTORS]);
    const covered = registry.descriptors.flatMap((descriptor) => descriptor.covers);
    expect(new Set(covered).size).toBe(covered.length);
    for (const row of EXPECTED_I2_ROWS) {
      expect(
        registry.descriptors.filter((descriptor) => descriptor.covers.includes(row)),
      ).toHaveLength(1);
    }
  });

  test("pins each descriptor's inventory row and capability gate", () => {
    for (const descriptor of I2_DESCRIPTORS) {
      expect({ covers: descriptor.covers, requires: descriptor.requires }).toEqual(
        expectedCapabilityTable[descriptor.id],
      );
    }
    expect(I2_DIALOG_DESCRIPTORS.find((descriptor) => descriptor.id === "I2.pluginSettings")).toBe(
      I2_DESCRIPTORS.find((descriptor) => descriptor.id === "I2.pluginSettings"),
    );
    expect(I2_PANEL_DESCRIPTORS).toHaveLength(1);
    expect(I2_SETTING_DESCRIPTORS).toHaveLength(1);
  });

  test("unreported plugin settings stay unavailable with omp's standing reason", () => {
    const hostCapabilities = new Set<CapabilityKey>(
      Object.values(expectedCapabilityTable).flatMap(({ requires }) =>
        requires.filter((key): key is `host.${string}` => key.startsWith("host.")),
      ),
    );
    const availableHosts = CapabilityMap.parse(
      Object.fromEntries(
        [...hostCapabilities].map((key) => [key, { state: "available", via: "host" }]),
      ),
    );
    const pluginSettings = I2_DESCRIPTORS.find(
      (descriptor) => descriptor.id === "I2.pluginSettings",
    );
    if (!pluginSettings) throw new Error("Missing the plugin settings descriptor.");
    expect(
      I2_DESCRIPTORS.filter((descriptor) => descriptor.id !== "I2.pluginSettings").every(
        (descriptor) => isDescriptorAvailable(descriptor, availableHosts),
      ),
    ).toBe(true);
    expect(isDescriptorAvailable(pluginSettings, availableHosts)).toBe(false);
    expect(capabilityStatus({}, "upstream.plugin-settings")).toEqual(UPSTREAM_UNAVAILABLE);

    const withoutCommandGateway = CapabilityMap.parse(
      Object.fromEntries(
        [...hostCapabilities]
          .filter((key) => key !== "host.command-gateway")
          .map((key) => [key, { state: "available", via: "host" }]),
      ),
    );
    const expectedUnavailable = Object.entries(expectedCapabilityTable)
      .filter(([, expected]) => expected.requires.includes("host.command-gateway"))
      .map(([id]) => id)
      .sort();
    expect(
      I2_DESCRIPTORS.filter(
        (descriptor) => !isDescriptorAvailable(descriptor, withoutCommandGateway),
      )
        .map((descriptor) => descriptor.id)
        .sort(),
    ).toEqual([...expectedUnavailable, "I2.pluginSettings"].sort());
  });

  test("runs the catalog fixture through the safe metadata normalizer", () => {
    const catalog = normalizeCatalog(I2_CATALOG_FIXTURE);
    expect(catalog.extensions).toHaveLength(2);
    expect(catalog.skills).toHaveLength(1);
    expect(catalog.prompts).toHaveLength(1);
    expect(catalog.extensions.find((item) => item.id === "unsafe-entry")?.path).toBeUndefined();
    expect(catalog.extensions.find((item) => item.id === "demo-plugin")?.path).toBe(
      "plugins/demo-plugin",
    );
  });

  test("runs the gateway fixture through redaction and rejects a live credential", async () => {
    const run = vi.fn(async () => I2_GATEWAY_FIXTURE);
    const port = createMarketplacePort(fakeGatewayClient(run));
    const fixtureResult = await port.run({
      operation: "list",
      threadId: ThreadId.parse("i2-gate-thread"),
    });
    expect(fixtureResult.outputs[0]?.text).toBe(
      "Marketplace: demo\nAuthorization: Bearer <REDACTED:token>\nhttps://demo.test/?token=<redacted>",
    );
    run.mockResolvedValueOnce({
      ...I2_GATEWAY_FIXTURE,
      outputs: [{ text: ["Authorization: Bearer", "t".repeat(12)].join(" ") }],
    });
    const redactedResult = await port.run({
      operation: "list",
      threadId: ThreadId.parse("i2-gate-thread"),
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(redactedResult.outputs[0]?.text).toBe("Authorization: Bearer <redacted>");
    expect(redactedResult.outputs[0]?.text).not.toContain("t".repeat(12));
  });

  test("keeps ConfigStore provenance and secret values typed and scrubbed", () => {
    const config = I2_CONFIG_LIST_FIXTURE;
    const setting = config.entries.find((entry) => entry.key === "skills.registryUrl");
    const secret = config.entries.find((entry) => entry.key === "auth.apiKey");
    expect(setting).toMatchObject({
      secret: false,
      value: "https://skills.omp.sh",
      source: "default",
      provenance: { origin: "fixture", ompVersion: "18.9.1" },
    });
    expect(secret).toMatchObject({ secret: true, isSet: true, source: "global" });
    expect(secret && "value" in secret).toBe(false);
    expect(checkScrubbed(JSON.stringify(I2_CATALOG_FIXTURE))).toEqual([]);
    expect(checkScrubbed(JSON.stringify(I2_GATEWAY_FIXTURE))).toEqual([]);
    expect(checkScrubbed(JSON.stringify(config))).toEqual([]);
  });
});
