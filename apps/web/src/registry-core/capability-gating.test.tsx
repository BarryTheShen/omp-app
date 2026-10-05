import type { CapabilityMap, Descriptor, DescriptorId } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  createRegistry,
  isDescriptorAvailable,
  useDescriptor,
  useIsDescriptorAvailable,
} from "./index";
import { withRegistry } from "./test-support";

afterEach(cleanup);

const open: Descriptor = {
  id: "U0.openAlways",
  owner: "U0",
  title: "Always open",
  covers: [],
  requires: [],
  kind: "dialog",
};
const gated: Descriptor = {
  id: "U0.gatedDialog",
  owner: "U0",
  title: "Gated dialog",
  covers: [],
  requires: ["host.test-feature"],
  kind: "dialog",
};

const registry = createRegistry([open, gated]);

describe("isDescriptorAvailable", () => {
  test("is true when a descriptor requires nothing", () => {
    expect(isDescriptorAvailable(open, {})).toBe(true);
  });

  test("needs every required capability, not just one of them", () => {
    const doublyGated: Descriptor = {
      ...gated,
      id: "U0.doublyGated",
      requires: ["host.test-feature", "host.other-feature"],
    };
    const oneAvailable: CapabilityMap = {
      "host.test-feature": { state: "available", via: "host" },
    };
    const bothAvailable: CapabilityMap = {
      "host.test-feature": { state: "available", via: "host" },
      "host.other-feature": { state: "available", via: "host" },
    };

    expect(isDescriptorAvailable(doublyGated, {})).toBe(false);
    expect(isDescriptorAvailable(doublyGated, oneAvailable)).toBe(false);
    expect(isDescriptorAvailable(doublyGated, bothAvailable)).toBe(true);
  });

  test("a fallback counts as usable; unavailable and unknown do not", () => {
    const fallback: CapabilityMap = {
      "host.test-feature": { state: "fallback", via: "host", detail: "partial support" },
    };
    const unavailable: CapabilityMap = {
      "host.test-feature": { state: "unavailable", via: "host" },
    };

    expect(isDescriptorAvailable(gated, fallback)).toBe(true);
    expect(isDescriptorAvailable(gated, unavailable)).toBe(false);
    expect(isDescriptorAvailable(gated, {})).toBe(false);
  });
});

describe("useIsDescriptorAvailable", () => {
  function GatedTitle({ id }: { id: DescriptorId }) {
    const descriptor = useDescriptor(id);
    const available = useIsDescriptorAvailable(id);
    if (descriptor === undefined || !available) return null;
    return <span>{descriptor.title}</span>;
  }

  test("hides a descriptor until its required capability is present", () => {
    const { rerender } = render(withRegistry(registry, {}, <GatedTitle id="U0.gatedDialog" />));
    expect(screen.queryByText("Gated dialog")).toBeNull();

    rerender(
      withRegistry(
        registry,
        { "host.test-feature": { state: "available", via: "host" } },
        <GatedTitle id="U0.gatedDialog" />,
      ),
    );
    expect(screen.getByText("Gated dialog")).toBeTruthy();
  });

  test("a descriptor with no requirements is available without any capability reported", () => {
    render(withRegistry(registry, {}, <GatedTitle id="U0.openAlways" />));
    expect(screen.getByText("Always open")).toBeTruthy();
  });

  test("is false for an id the registry has none of", () => {
    const { container } = render(withRegistry(registry, {}, <GatedTitle id="U0.doesNotExist" />));
    expect(container.textContent).toBe("");
  });
});
