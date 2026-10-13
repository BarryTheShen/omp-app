import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ShortcutRegistryProvider, ShortcutSheet } from "./index";

afterEach(() => cleanup());

describe("#1257 the shortcut sheet's Typed commands", () => {
  test("lists /hub under its own heading, with the plain-English title", () => {
    render(
      <ShortcutRegistryProvider descriptors={[]}>
        <ShortcutSheet open onOpenChange={() => undefined} />
      </ShortcutRegistryProvider>,
    );
    expect(screen.getByRole("heading", { name: "Typed commands" })).toBeTruthy();
    expect(screen.getByText("Open the Agent Hub")).toBeTruthy();
    expect(screen.getByText("/hub")).toBeTruthy();
  });

  test("the search keeps /hub for a query that matches it, and hides it for one that does not", () => {
    render(
      <ShortcutRegistryProvider descriptors={[]}>
        <ShortcutSheet open onOpenChange={() => undefined} />
      </ShortcutRegistryProvider>,
    );
    const search = screen.getByLabelText("Search shortcuts");
    fireEvent.change(search, { target: { value: "hub" } });
    expect(screen.getByText("/hub")).toBeTruthy();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.queryByText("/hub")).toBeNull();
    expect(screen.getByText("No shortcuts found.")).toBeTruthy();
  });
});
