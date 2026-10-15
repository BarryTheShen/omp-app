import type { Descriptor } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { ShortcutRegistryProvider, ShortcutSheet, ShortcutSheetHost } from "./index";
import { MemoryPreferenceStore, SHORTCUT_PREFERENCES_KEY } from "./registry";

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
  test("reads each chord the way the person's keyboard names it, and searches by that name too", () => {
    render(
      <Provider>
        <ShortcutSheet open onOpenChange={() => undefined} />
      </Provider>,
    );
    expect(screen.getByRole("button", { name: "Ctrl+Enter" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Alt+T" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mod+Enter" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search shortcuts" }), {
      target: { value: "ctrl+enter" },
    });
    expect(screen.getByText("Send message")).toBeTruthy();
    expect(screen.queryByText("Toggle thinking")).toBeNull();
  });
  test("on a Mac the same chords read with Cmd and Option", () => {
    const userAgent = vi
      .spyOn(navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
    try {
      render(
        <Provider>
          <ShortcutSheet open onOpenChange={() => undefined} />
        </Provider>,
      );
      expect(screen.getByRole("button", { name: "Cmd+Enter" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Option+T" })).toBeTruthy();
    } finally {
      userAgent.mockRestore();
    }
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
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+Enter" }));
    const input = screen.getByRole("textbox", { name: "Rebind Send message" });
    expect(input).toHaveProperty("value", "Ctrl+Enter");
    fireEvent.change(input, { target: { value: "Mod+Shift+Enter" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert").textContent).toBe(
      "Ctrl+Shift+Enter is already used by “Other composer shortcut”.",
    );
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

function renderSheet(store: MemoryPreferenceStore) {
  return render(
    <ShortcutRegistryProvider descriptors={descriptors} preferenceStore={store}>
      <ShortcutSheet open onOpenChange={() => undefined} />
    </ShortcutRegistryProvider>,
  );
}

/** The overrides the registry has stored, as the preference store holds them. */
function storedOverrides(store: MemoryPreferenceStore): Record<string, string> {
  const raw = store.get(SHORTCUT_PREFERENCES_KEY);
  return raw === undefined ? {} : z.record(z.string(), z.string()).parse(JSON.parse(raw));
}

describe("the rebind field speaks the person's key names", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  test("typing the name the field shows stores the chord the registry matches", () => {
    const store = new MemoryPreferenceStore();
    renderSheet(store);
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+Enter" }));
    const input = screen.getByRole("textbox", { name: "Rebind Send message" });
    expect(input).toHaveProperty("value", "Ctrl+Enter");
    fireEvent.change(input, { target: { value: "Ctrl+Shift+J" } });
    fireEvent.blur(input);
    expect(storedOverrides(store)).toEqual({ "U0.send": "Mod+Shift+J" });
    expect(screen.getByRole("button", { name: "Ctrl+Shift+J" })).toBeTruthy();
  });

  test("on an Apple platform the field shows Cmd and Option, and typing them stores Mod and Alt", () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    );
    const store = new MemoryPreferenceStore();
    renderSheet(store);
    fireEvent.click(screen.getByRole("button", { name: "Cmd+Enter" }));
    const input = screen.getByRole("textbox", { name: "Rebind Send message" });
    expect(input).toHaveProperty("value", "Cmd+Enter");
    fireEvent.change(input, { target: { value: "Cmd+Shift+J" } });
    fireEvent.blur(input);
    expect(storedOverrides(store)).toEqual({ "U0.send": "Mod+Shift+J" });
    expect(screen.getByRole("button", { name: "Cmd+Shift+J" })).toBeTruthy();
  });

  test("leaving the field with its text unchanged stores nothing", () => {
    const store = new MemoryPreferenceStore();
    renderSheet(store);
    fireEvent.click(screen.getByRole("button", { name: "Alt+T" }));
    fireEvent.blur(screen.getByRole("textbox", { name: "Rebind Toggle thinking" }));
    expect(storedOverrides(store)).toEqual({});
  });

  test("a chord the browser keeps is refused in the name the person typed", () => {
    renderSheet(new MemoryPreferenceStore());
    fireEvent.click(screen.getByRole("button", { name: "Alt+T" }));
    const input = screen.getByRole("textbox", { name: "Rebind Toggle thinking" });
    fireEvent.change(input, { target: { value: "Ctrl+J" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert").textContent).toBe("Your browser keeps Ctrl+J for itself");
  });

  test("a chord with no key is refused in one sentence, and the old chord keeps working", () => {
    const store = new MemoryPreferenceStore();
    renderSheet(store);
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+Enter" }));
    const input = screen.getByRole("textbox", { name: "Rebind Send message" });
    fireEvent.change(input, { target: { value: "Ctrl+Shift+" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert").textContent).toBe("Add a key, for example Ctrl+K.");
    expect(storedOverrides(store)).toEqual({});
    expect(screen.getByRole("button", { name: "Ctrl+Enter" })).toBeTruthy();
  });

  test("Control is stored as Mod, so the sheet and the registry agree on the chord", () => {
    const store = new MemoryPreferenceStore();
    renderSheet(store);
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+Enter" }));
    const input = screen.getByRole("textbox", { name: "Rebind Send message" });
    fireEvent.change(input, { target: { value: "Control+Shift+J" } });
    fireEvent.blur(input);
    expect(storedOverrides(store)).toEqual({ "U0.send": "Mod+Shift+J" });
    expect(screen.getByRole("button", { name: "Ctrl+Shift+J" })).toBeTruthy();
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

describe("the refusal names every other shortcut that already uses the chord, each once", () => {
  test("two different shortcuts are named together, and the one listed twice is named once", () => {
    const shared: readonly Descriptor[] = [
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
        id: "U2.other",
        owner: "U2",
        title: "Other composer shortcut",
        kind: "shortcut",
        chord: "Mod+Shift+Enter",
        scope: "composer",
        covers: [],
        requires: [],
      },
      {
        id: "U2.duplicate",
        owner: "U2",
        title: "Other composer shortcut",
        kind: "shortcut",
        chord: "Mod+Shift+Enter",
        scope: "global",
        covers: [],
        requires: [],
      },
      {
        id: "U2.third",
        owner: "U2",
        title: "Third shortcut",
        kind: "shortcut",
        chord: "Mod+Shift+Enter",
        scope: "global",
        covers: [],
        requires: [],
      },
    ];
    render(
      <ShortcutRegistryProvider descriptors={shared} preferenceStore={new MemoryPreferenceStore()}>
        <ShortcutSheet open onOpenChange={() => undefined} />
      </ShortcutRegistryProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+Enter" }));
    const input = screen.getByRole("textbox", { name: "Rebind Send message" });
    fireEvent.change(input, { target: { value: "Mod+Shift+Enter" } });
    fireEvent.blur(input);

    expect(screen.getByRole("alert").textContent).toBe(
      "Ctrl+Shift+Enter is already used by “Other composer shortcut” and “Third shortcut”.",
    );
  });
});
