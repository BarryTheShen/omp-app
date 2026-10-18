import {
  CapabilityStatus,
  type Descriptor,
  INVENTORY,
  ThreadId,
  validateRegistry,
} from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { DESCRIPTORS } from "@/registry";
import { createRegistry } from "@/registry-core";
import {
  capabilityStatus,
  isDescriptorAvailable,
  UPSTREAM_UNAVAILABLE,
} from "@/registry-core/hooks";
import { planActionAvailability } from "../actions";
import type { PlanDocumentInput, PlanDocumentStoreSource } from "../contract";
import * as descriptorBarrel from "../descriptors";
import { PlanModeController } from "../mode/mode";
import { PlanModeStatus } from "../mode/status";

const P2_DESCRIPTORS = descriptorBarrel.P2_DESCRIPTORS;

const P2_ROWS = [
  "P2.plan",
  "P2.plan-review-command",
  "P2.plan-mode",
  "P2.plan-review-mode",
  "P2.plan-annotation-editor",
  "P2.app-plan-toggle",
  "P2.plan-review-overlay",
  "P2.plan-mode-status",
  "P2.plan-table-of-contents",
] as const;

const EXPECTED_DESCRIPTOR_GATE: Readonly<
  Record<string, { covers: readonly string[]; requires: readonly string[] }>
> = {
  "P2.plan": {
    covers: ["P2.plan"],
    requires: ["client.plan-document", "upstream.plan-mode"],
  },
  "P2.planReviewCommand": {
    covers: ["P2.plan-review-command"],
    requires: ["client.plan-document", "upstream.plan-mode"],
  },
  "P2.planMode": {
    covers: ["P2.plan-mode"],
    requires: ["client.plan-document", "upstream.plan-mode"],
  },
  "P2.planReviewMode": {
    covers: ["P2.plan-review-mode"],
    requires: ["client.plan-document", "upstream.plan-mode"],
  },
  "P2.planModeStatus": {
    covers: ["P2.plan-mode-status"],
    requires: ["client.plan-document"],
  },
  "P2.planAnnotationEditor": {
    covers: ["P2.plan-annotation-editor"],
    requires: ["client.plan-document", "omp.ui"],
  },
  "P2.appPlanToggle": {
    covers: ["P2.app-plan-toggle"],
    requires: ["client.plan-document", "upstream.plan-mode"],
  },
  "P2.planReviewOverlay": {
    covers: ["P2.plan-review-overlay"],
    requires: ["client.plan-document", "omp.ui"],
  },
  "P2.planTableOfContents": {
    covers: ["P2.plan-table-of-contents"],
    requires: ["client.plan-document", "omp.ui"],
  },
};

afterEach(cleanup);

describe("P2.7 W5 / CC7 / CC12 gate", () => {
  test("pins each descriptor to its inventory row and exact capability gate", () => {
    const byId = new Map<string, Descriptor>(P2_DESCRIPTORS.map((item) => [item.id, item]));
    expect(P2_ROWS.every((id) => INVENTORY.some((row) => row.id === id))).toBe(true);
    expect(P2_DESCRIPTORS).toHaveLength(P2_ROWS.length);
    expect(Object.keys(EXPECTED_DESCRIPTOR_GATE)).toHaveLength(P2_DESCRIPTORS.length);
    for (const descriptor of P2_DESCRIPTORS) {
      const expected = EXPECTED_DESCRIPTOR_GATE[descriptor.id];
      expect(expected).toBeDefined();
      expect(byId.get(descriptor.id)?.covers).toEqual(expected?.covers);
      expect(byId.get(descriptor.id)?.requires).toEqual(expected?.requires);
    }
    const claimed = P2_DESCRIPTORS.flatMap((item) => item.covers);
    expect([...claimed].sort()).toEqual([...P2_ROWS].sort());
    expect(new Set(claimed).size).toBe(claimed.length);
  });
  test("publishes the explicit descriptor surface and no fixtures", () => {
    expect(Object.keys(descriptorBarrel).sort()).toEqual([
      "P2_COMMAND_DESCRIPTORS",
      "P2_DESCRIPTORS",
      "P2_DIALOG_DESCRIPTORS",
      "P2_MODE_DESCRIPTORS",
      "P2_PANEL_DESCRIPTORS",
      "P2_SHORTCUT_DESCRIPTORS",
    ]);
  });

  test("composes descriptors with the central registry without double-claiming an inventory row", () => {
    const composed = createRegistry([...DESCRIPTORS, ...P2_DESCRIPTORS]);
    expect(validateRegistry(composed.descriptors)).toEqual([]);
    const claims = composed.descriptors.flatMap((descriptor) => descriptor.covers);
    for (const row of P2_ROWS) {
      expect(claims.filter((claimed) => claimed === row)).toHaveLength(1);
    }
  });

  test("gates every descriptor in both directions and exposes the standing upstream reason", () => {
    const available = (via: "client" | "upstream") =>
      CapabilityStatus.parse({ state: "available", via });
    const allCapabilities = {
      "client.plan-document": available("client"),
      "upstream.plan-mode": available("upstream"),
      "omp.ui": available("client"),
    };
    const withoutDocument = {
      "upstream.plan-mode": available("upstream"),
      "omp.ui": available("client"),
    };
    const documentOnly = {
      "client.plan-document": available("client"),
    };
    const documentAndUi = {
      ...documentOnly,
      "omp.ui": available("client"),
    };
    const registry = createRegistry(P2_DESCRIPTORS);

    for (const descriptor of P2_DESCRIPTORS) {
      expect(isDescriptorAvailable(descriptor, allCapabilities)).toBe(true);
      expect(isDescriptorAvailable(descriptor, withoutDocument)).toBe(false);
    }

    expect(capabilityStatus(documentOnly, "upstream.plan-mode")).toEqual(UPSTREAM_UNAVAILABLE);
    for (const id of [
      "P2.plan",
      "P2.planReviewCommand",
      "P2.planMode",
      "P2.planReviewMode",
      "P2.appPlanToggle",
    ] as const) {
      const descriptor = registry.byId.get(id);
      expect(descriptor).toBeDefined();
      expect(isDescriptorAvailable(descriptor as Descriptor, documentOnly)).toBe(false);
    }
    expect(
      isDescriptorAvailable(registry.byId.get("P2.planModeStatus") as Descriptor, documentOnly),
    ).toBe(true);
    for (const id of [
      "P2.planAnnotationEditor",
      "P2.planReviewOverlay",
      "P2.planTableOfContents",
    ] as const) {
      const descriptor = registry.byId.get(id);
      expect(descriptor).toBeDefined();
      expect(isDescriptorAvailable(descriptor as Descriptor, documentOnly)).toBe(false);
      expect(isDescriptorAvailable(descriptor as Descriptor, documentAndUi)).toBe(true);
    }

    expect(
      planActionAvailability().map(({ action, authority, enabled }) => ({
        action,
        authority,
        enabled,
      })),
    ).toEqual([
      { action: "approve", authority: "upstream", enabled: false },
      { action: "refine", authority: "host", enabled: true },
      { action: "execute", authority: "upstream", enabled: false },
      { action: "cancel", authority: "upstream", enabled: false },
    ]);
    expect(
      planActionAvailability(available("upstream")).every(
        (action) => action.authority === "host" || action.enabled,
      ),
    ).toBe(true);
  });
  test("slash commands and the app shortcut keep their owned names and keyboard chord", () => {
    const plan = P2_DESCRIPTORS.find((descriptor) => descriptor.id === "P2.plan");
    const review = P2_DESCRIPTORS.find((descriptor) => descriptor.id === "P2.planReviewCommand");
    const shortcut = P2_DESCRIPTORS.find((descriptor) => descriptor.id === "P2.appPlanToggle");
    expect(plan).toMatchObject({ kind: "command", slash: { name: "plan", source: "builtin" } });
    expect(review).toMatchObject({
      kind: "command",
      slash: { name: "plan-review", source: "builtin" },
    });
    expect(shortcut).toMatchObject({
      kind: "shortcut",
      chord: "alt+shift+p",
      scope: "global",
    });
  });

  test("plan mode toggle exposes its unavailable reason to assistive technology", async () => {
    const threadId = ThreadId.parse("p2-accessibility");
    const document: PlanDocumentInput = {
      id: "plan",
      threadId,
      markdown: "# Plan",
      sections: [{ id: "plan", heading: "Plan", start: 0, end: 6 }],
      annotations: [],
      status: "draft",
    };
    const store: PlanDocumentStoreSource = {
      load: async () => ({
        document: { ...document, revision: 1, updatedAt: "2026-10-18T00:00:00.000Z" },
        revisions: [],
      }),
      save: async (next, expectedRevision) => ({
        document: {
          ...next,
          revision: expectedRevision + 1,
          updatedAt: "2026-10-18T00:00:00.000Z",
        },
        revisions: [],
      }),
      export: async (documentId, format) => ({ documentId, format, text: document.markdown }),
      subscribeChanged: () => () => undefined,
    };
    const capability = CapabilityStatus.parse({
      state: "unavailable",
      via: "upstream",
      detail: "Plan mode is unavailable in this version of omp.",
    });
    const controller = new PlanModeController({ store, threadId, capability });
    try {
      await controller.load();
      render(<PlanModeStatus controller={controller} />);
      const button = screen.getByRole("button", { name: "Plan mode" });
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(button.getAttribute("aria-pressed")).toBe("true");
      const reason = screen.getByRole("status");
      expect(reason.textContent).toContain("Plan mode is unavailable in this version of omp.");
      expect(button.getAttribute("aria-describedby")).toBe(reason.id);
    } finally {
      controller.dispose();
    }
  });
});
