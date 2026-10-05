import type { Descriptor, DescriptorId } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  createRegistry,
  useCapabilities,
  useCapability,
  useDescriptor,
  useDescriptors,
} from "./index";
import { withRegistry } from "./test-support";

afterEach(cleanup);

const dialogA: Descriptor = {
  id: "U0.confirm",
  owner: "U0",
  title: "Confirm",
  covers: [],
  requires: [],
  kind: "dialog",
};
const dialogB: Descriptor = {
  id: "U0.discard",
  owner: "U0",
  title: "Discard",
  covers: [],
  requires: [],
  kind: "dialog",
};
const statusA: Descriptor = {
  id: "U0.connection",
  owner: "U0",
  title: "Connection",
  covers: [],
  requires: [],
  kind: "status",
};

const registry = createRegistry([dialogA, dialogB, statusA]);

describe("useDescriptors", () => {
  function Dump() {
    const dialogs = useDescriptors("dialog");
    const panels = useDescriptors("panel");
    return (
      <>
        <span data-testid="dialogs">{dialogs.map((d) => d.id).join(",")}</span>
        <span data-testid="panels">{panels.length}</span>
      </>
    );
  }

  test("groups registered descriptors by kind", () => {
    render(withRegistry(registry, {}, <Dump />));
    expect(screen.getByTestId("dialogs").textContent).toBe("U0.confirm,U0.discard");
  });

  test("returns an empty array for a kind nothing registered", () => {
    render(withRegistry(registry, {}, <Dump />));
    expect(screen.getByTestId("panels").textContent).toBe("0");
  });
});

describe("useDescriptor", () => {
  function Title({ id }: { id: DescriptorId }) {
    const descriptor = useDescriptor(id);
    return <span>{descriptor?.title ?? "not found"}</span>;
  }

  test("finds a registered descriptor by id", () => {
    render(withRegistry(registry, {}, <Title id="U0.connection" />));
    expect(screen.getByText("Connection")).toBeTruthy();
  });

  test("is undefined for an id the registry has none of", () => {
    render(withRegistry(registry, {}, <Title id="U0.doesNotExist" />));
    expect(screen.getByText("not found")).toBeTruthy();
  });
});

describe("useCapability", () => {
  function Status() {
    const available = useCapability("host.test-feature");
    return <span>{available ? "available" : "unavailable"}</span>;
  }

  test("is false when the capability was never reported", () => {
    render(withRegistry(registry, {}, <Status />));
    expect(screen.getByText("unavailable")).toBeTruthy();
  });

  test("is true when the capability is available or a fallback, false when unknown or unavailable", () => {
    const { rerender } = render(withRegistry(registry, {}, <Status />));
    expect(screen.getByText("unavailable")).toBeTruthy();

    rerender(
      withRegistry(
        registry,
        { "host.test-feature": { state: "available", via: "host" } },
        <Status />,
      ),
    );
    expect(screen.getByText("available")).toBeTruthy();

    rerender(
      withRegistry(
        registry,
        { "host.test-feature": { state: "fallback", via: "host" } },
        <Status />,
      ),
    );
    expect(screen.getByText("available")).toBeTruthy();

    rerender(
      withRegistry(
        registry,
        { "host.test-feature": { state: "unavailable", via: "host" } },
        <Status />,
      ),
    );
    expect(screen.getByText("unavailable")).toBeTruthy();
  });
});

describe("useCapabilities", () => {
  function Keys() {
    const capabilities = useCapabilities();
    return <span>{Object.keys(capabilities).join(",")}</span>;
  }

  test("returns the whole live capability map", () => {
    render(
      withRegistry(
        registry,
        {
          "host.test-feature": { state: "available", via: "host" },
          "host.other-feature": { state: "unavailable", via: "host" },
        },
        <Keys />,
      ),
    );
    expect(screen.getByText("host.test-feature,host.other-feature")).toBeTruthy();
  });
});
