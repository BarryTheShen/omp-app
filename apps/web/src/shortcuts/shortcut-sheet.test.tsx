import type { Descriptor } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ShortcutRegistryProvider, ShortcutSheet, ShortcutSheetHost } from "./index";
import { MemoryPreferenceStore } from "./registry";

const descriptors: readonly Descriptor[] = [
  {
    id: "U0.sheet",
    owner: "U0",
    title: "Shortcut sheet",
    kind: "shortcut",
    chord: "Mod+?",
    scope: "global",
    covers: [],
    requires: [],
  },
  {
    id: "U0.send",
    owner: "U0",
    title: "Send message",
    kind: "shortcut",
    chord: "Mod+Enter",
    scope: "composer",
    covers: [],
    requires: [],
  },
  {
    id: "U1.toggle",
    owner: "U1",
    title: "Toggle thinking",
    kind: "shortcut",
    chord: "Alt+T",
    scope: "transcript",
    covers: [],
    requires: [],
  },
  {
    id: "U2.other",
    owner: "U2",
    title: "Other composer shortcut",
    kind: "shortcut",
    chord: "Mod+Shift+Enter",
    scope: "composer",
    covers: [],
    requires: [],
  },
];
const browserReservedDescriptor: Descriptor = {
  id: "U3.browser",
  owner: "U3",
  title: "Browser-owned shortcut",
  kind: "shortcut",
  chord: "Mod+N",
  scope: "global",
  covers: [],
  requires: [],
};

afterEach(cleanup);

function Provider({ children }: { readonly children: React.ReactNode }) {
  return (
    <ShortcutRegistryProvider
      descriptors={[...descriptors, browserReservedDescriptor]}
      preferenceStore={new MemoryPreferenceStore()}
    >
      {children}
    </ShortcutRegistryProvider>
  );
}

describe("ShortcutSheet", () => {
  test("groups shortcuts and filters them by search", () => {
    render(
      <Provider>
        <ShortcutSheet open onOpenChange={() => undefined} />
      </Provider>,
    );
    expect(screen.getByText("Global")).toBeTruthy();
    expect(screen.getByText("Composer")).toBeTruthy();
    expect(screen.getByText("Transcript")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search shortcuts" }), {
      target: { value: "send" },
    });
    expect(screen.getByText("Send message")).toBeTruthy();
    expect(screen.queryByText("Toggle thinking")).toBeNull();
  });
  test("marks browser-reserved default chords", () => {
    render(
      <Provider>
        <ShortcutSheet open onOpenChange={() => undefined} />
      </Provider>,
    );

    expect(screen.getByText("Browser reserved")).toBeTruthy();
    expect(screen.getByTitle("Your browser keeps this default shortcut for itself")).toBeTruthy();
  });

  test("opens from ? and does not open from editable input", () => {
    render(
      <Provider>
        <ShortcutSheetHost>
          <input aria-label="Draft" />
        </ShortcutSheetHost>
      </Provider>,
    );
    fireEvent.keyDown(window, { key: "?", cancelable: true });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    cleanup();
    render(
      <Provider>
        <ShortcutSheetHost>
          <input aria-label="Draft" />
        </ShortcutSheetHost>
      </Provider>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Draft" }), { key: "?" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  test("shows conflict warning before saving a rebind", () => {
    render(
      <Provider>
        <ShortcutSheet open onOpenChange={() => undefined} />
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mod+Enter" }));
    const input = screen.getByRole("textbox", { name: "Rebind Send message" });
    fireEvent.change(input, { target: { value: "Mod+Shift+Enter" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert").textContent).toContain("U0 and U2");
  });
  test("resets an overridden shortcut row to its default", () => {
    render(
      <Provider>
        <ShortcutSheet open onOpenChange={() => undefined} />
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Alt+T" }));
    const input = screen.getByRole("textbox", { name: "Rebind Toggle thinking" });
    fireEvent.change(input, { target: { value: "Alt+Y" } });
    fireEvent.blur(input);

    const reset = screen.getByRole("button", { name: "Reset Toggle thinking" });
    expect(screen.getByRole("button", { name: "Alt+Y" })).toBeTruthy();
    fireEvent.click(reset);
    expect(screen.getByRole("button", { name: "Alt+T" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset Toggle thinking" })).toBeNull();
  });
});

describe("ShortcutSheet capability gating", () => {
  test("does not offer a shortcut whose omp command is missing, but offers the others", () => {
    const gated: Descriptor = {
      id: "P4.gated",
      owner: "P4",
      title: "Gated conversation shortcut",
      kind: "shortcut",
      chord: "Mod+Shift+G",
      scope: "global",
      covers: [],
      requires: ["omp.cmd.get_tree"],
    };
    render(
      <ShortcutRegistryProvider
        descriptors={[...descriptors, gated]}
        preferenceStore={new MemoryPreferenceStore()}
      >
        <ShortcutSheet open onOpenChange={() => undefined} />
      </ShortcutRegistryProvider>,
    );
    expect(screen.getByText("Send message")).toBeTruthy();
    expect(screen.queryByText("Gated conversation shortcut")).toBeNull();
  });
});
