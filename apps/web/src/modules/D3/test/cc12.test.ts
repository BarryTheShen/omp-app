import {
  Descriptor,
  type Descriptor as DescriptorValue,
  validateRegistry,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { D3_DESCRIPTORS } from "../descriptors/index";

const D3_ROWS = new Set([
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

function gateState(descriptors: readonly DescriptorValue[]) {
  const covered = descriptors.flatMap((descriptor) => descriptor.covers);
  const expectedCapability = (row: string): string | undefined => {
    if (row === "D4.login") return "omp.cmd.get_login_providers";
    if (row === "D4.logout" || row.includes("account-selector")) return "host.provider-accounts";
    if (row === "D4.login-dialog") return "omp.cmd.login";
    if (row === "C1.setup" || row === "C1.setup-providers")
      return "upstream.provider-setup-commands";
    if (row === "C1.setup-wizard") return "upstream.setup-wizard";
    if (row.startsWith("S5.providers-")) return "host.config";
    return undefined;
  };
  return {
    coverageValid:
      covered.length === D3_ROWS.size &&
      new Set(covered).size === covered.length &&
      covered.every((row) => D3_ROWS.has(row)),
    idsValid:
      new Set(descriptors.map((descriptor) => descriptor.id)).size === descriptors.length &&
      descriptors.every((descriptor) => descriptor.owner === "D3"),
    capabilitiesValid: descriptors.every((descriptor) =>
      descriptor.covers.every((row) => {
        const required = expectedCapability(row);
        return required === undefined || descriptor.requires.includes(required as never);
      }),
    ),
  };
}

describe("D3 CC12 descriptor gate", () => {
  test("the complete descriptor set validates and covers each D3 row once", () => {
    expect(validateRegistry(D3_DESCRIPTORS)).toEqual([]);
    expect(gateState(D3_DESCRIPTORS)).toEqual({
      coverageValid: true,
      idsValid: true,
      capabilitiesValid: true,
    });
  });

  test("shared descriptor schemas accept every D3 descriptor", () => {
    for (const descriptor of D3_DESCRIPTORS) {
      expect(Descriptor.safeParse(descriptor).success).toBe(true);
    }
  });

  test("each production mutation fails the gate", () => {
    const duplicateId = D3_DESCRIPTORS.map((descriptor) =>
      descriptor.id === "D3.logout"
        ? { ...descriptor, id: "D3.login" as typeof descriptor.id }
        : descriptor,
    );
    expect(gateState(duplicateId).idsValid).toBe(false);

    const droppedRow = D3_DESCRIPTORS.map((descriptor) =>
      descriptor.id === "D3.setupWizard"
        ? { ...descriptor, covers: [] as typeof descriptor.covers }
        : descriptor,
    );
    expect(gateState(droppedRow).coverageValid).toBe(false);

    const changedGate = D3_DESCRIPTORS.map((descriptor) =>
      descriptor.id === "D3.logout"
        ? { ...descriptor, requires: ["omp.ui"] as typeof descriptor.requires }
        : descriptor,
    );
    expect(gateState(changedGate).capabilitiesValid).toBe(false);
  });
});
