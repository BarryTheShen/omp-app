import type { Descriptor, DescriptorId } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  createRegistry,
  type DescriptorRenderer,
  registerRenderers,
  useDescriptor,
  useRenderer,
} from "./index";
import { withRegistry } from "./test-support";

afterEach(cleanup);

const dialog: Descriptor = {
  id: "U0.confirm",
  owner: "U0",
  title: "Confirm",
  covers: [],
  requires: [],
  kind: "dialog",
};
const status: Descriptor = {
  id: "U0.connection",
  owner: "U0",
  title: "Connection",
  covers: [],
  requires: [],
  kind: "status",
};

const registry = createRegistry([dialog, status]);

const ConfirmDialog: DescriptorRenderer = ({ descriptor }) => <div>Dialog: {descriptor.title}</div>;
const renderers = registerRenderers({ "U0.confirm": ConfirmDialog });

function Host({ id }: { id: DescriptorId }) {
  const Renderer = useRenderer(id);
  const descriptor = useDescriptor(id);
  if (descriptor === undefined) return null;
  return <Renderer descriptor={descriptor} />;
}

describe("registerRenderers", () => {
  test("returns the exact map it was given, for spreading into the merged map", () => {
    const map = { "U0.confirm": ConfirmDialog };
    expect(registerRenderers(map)).toBe(map);
  });
});

describe("useRenderer", () => {
  test("looks up the renderer registered for a descriptor id", () => {
    render(withRegistry(registry, {}, <Host id="U0.confirm" />, renderers));
    expect(screen.getByText("Dialog: Confirm")).toBeTruthy();
  });

  test("renders a visible fallback instead of crashing when no renderer is registered", () => {
    expect(() =>
      render(withRegistry(registry, {}, <Host id="U0.connection" />, renderers)),
    ).not.toThrow();

    const fallback = screen.getByRole("alert");
    expect(fallback.textContent).toContain("U0.connection");
  });

  test("a map with one renderer still falls back correctly for every other id", () => {
    render(
      withRegistry(
        registry,
        {},
        <>
          <Host id="U0.confirm" />
          <Host id="U0.connection" />
        </>,
        renderers,
      ),
    );
    expect(screen.getByText("Dialog: Confirm")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("U0.connection");
  });
});
