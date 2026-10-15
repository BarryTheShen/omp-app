import type { Descriptor, ShortcutDescriptor } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { DESCRIPTORS } from "@/registry";
import { MemoryPreferenceStore, ShortcutRegistry } from "./registry";

// The command palette works in the message box too (`allowInEditable`), as the app declares it.
const palette = {
  kind: "shortcut",
  id: "U0.palette",
  owner: "U0",
  title: "Open command palette",
  covers: [],
  requires: [],
  chord: "Mod+K",
  scope: "global",
  allowInEditable: true,
} as const satisfies ShortcutDescriptor & { readonly allowInEditable: true };

// The external editor works only in the message box, as the app declares it.
const externalEditor = {
  kind: "shortcut",
  id: "U2.externalEditor",
  owner: "U2",
  title: "Open external editor",
  covers: [],
  requires: [],
  chord: "Mod+G",
  scope: "composer-input",
  allowInEditable: true,
  focus: "composer-input",
} as const satisfies ShortcutDescriptor & {
  readonly allowInEditable: true;
  readonly focus: "composer-input";
};

// A global shortcut that never runs while a text box has focus.
const outsideTextBoxes = {
  kind: "shortcut",
  id: "U0.outside",
  owner: "U0",
  title: "Open the outside shortcut",
  covers: [],
  requires: [],
  chord: "Alt+X",
  scope: "global",
} as const satisfies ShortcutDescriptor;

const transcriptToggle = {
  kind: "shortcut",
  id: "U1.toggle",
  owner: "U1",
  title: "Toggle thinking",
  covers: [],
  requires: [],
  chord: "Alt+T",
  scope: "transcript",
} as const satisfies ShortcutDescriptor;

// Two areas of the app that both take the arrow keys, each in its own place.
const composerLeft = {
  kind: "shortcut",
  id: "U2.cursorLeft",
  owner: "U2",
  title: "Move cursor left",
  covers: [],
  requires: [],
  chord: "ArrowLeft",
  scope: "composer",
} as const satisfies ShortcutDescriptor;

const treeFold = {
  kind: "shortcut",
  id: "P4.treeFold",
  owner: "P4",
  title: "Fold tree",
  covers: [],
  requires: [],
  chord: "ArrowLeft",
  scope: "tree",
} as const satisfies ShortcutDescriptor;

function registryOf(descriptors: readonly Descriptor[]): ShortcutRegistry {
  return new ShortcutRegistry(descriptors, { preferenceStore: new MemoryPreferenceStore() });
}

describe("a chord shared across scopes is refused only when one keypress could run both", () => {
  test("a text-box shortcut cannot take the chord of a global shortcut that works in text boxes", () => {
    const registry = registryOf([palette, externalEditor]);
    const result = registry.rebind("U2.externalEditor", "Mod+K");

    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      first: { id: "U0.palette", title: "Open command palette" },
      second: { id: "U2.externalEditor" },
    });
    expect(registry.bindings().find((b) => b.id === "U2.externalEditor")?.chord).toBe("Mod+G");
  });

  test("a text-box shortcut can take the chord of a global shortcut that never runs in a text box", () => {
    const registry = registryOf([outsideTextBoxes, externalEditor]);

    expect(registry.rebind("U2.externalEditor", "Alt+X").ok).toBe(true);
  });

  test("a global shortcut outside text boxes cannot take the chord of a transcript shortcut", () => {
    const registry = registryOf([outsideTextBoxes, transcriptToggle]);
    const result = registry.rebind("U1.toggle", "Alt+X");

    expect(result.ok).toBe(false);
    expect(result.conflicts[0]).toMatchObject({
      first: { id: "U0.outside" },
      second: { id: "U1.toggle" },
    });
  });

  test("a transcript shortcut cannot take the chord of a global shortcut that works in text boxes", () => {
    const registry = registryOf([palette, transcriptToggle]);

    expect(registry.rebind("U1.toggle", "Mod+K").ok).toBe(false);
  });

  test("a text-box shortcut can take the chord of a transcript shortcut, since they never meet", () => {
    const registry = registryOf([transcriptToggle, externalEditor]);

    expect(registry.rebind("U2.externalEditor", "Alt+T").ok).toBe(true);
  });

  test("two areas of the app can use one chord, since they meet only in a text box where neither takes it", () => {
    expect(registryOf([composerLeft, treeFold]).conflicts()).toEqual([]);
  });

  test("the app's default shortcuts share no chord that one keypress could run twice", () => {
    expect(registryOf(DESCRIPTORS).conflicts()).toEqual([]);
  });
});

// The composer's own shortcuts (Mod+R and the like) are declared in the composer scope and run only in the message box.
const composerHistory = {
  kind: "shortcut",
  id: "U2.historySearch",
  owner: "U2",
  title: "Open prompt history search",
  covers: [],
  requires: [],
  chord: "Mod+R",
  scope: "composer",
  allowInEditable: true,
  focus: "composer-input",
} as const satisfies ShortcutDescriptor & {
  readonly allowInEditable: true;
  readonly focus: "composer-input";
};

// A global shortcut that never runs while a text box has focus (Alt+C in the app).
const copyFromChat = {
  kind: "shortcut",
  id: "D4.copyFromChat",
  owner: "D4",
  title: "Copy from this chat",
  covers: [],
  requires: [],
  chord: "Alt+C",
  scope: "global",
} as const satisfies ShortcutDescriptor;

// The same global shortcut, if it also worked in the message box.
const copyEverywhere = {
  ...copyFromChat,
  id: "D4.copyEverywhere",
  title: "Copy from this chat in the message box too",
  allowInEditable: true,
} as const satisfies ShortcutDescriptor & { readonly allowInEditable: true };

// A shortcut limited to the session list, and one limited to the message box, both on one chord.
const sessionRename = {
  kind: "shortcut",
  id: "R1.rename",
  owner: "R1",
  title: "Rename session",
  covers: [],
  requires: [],
  chord: "Mod+Q",
  scope: "session-list",
  focus: "session-list",
} as const satisfies ShortcutDescriptor & { readonly focus: "session-list" };

const boxOnly = {
  kind: "shortcut",
  id: "U2.boxOnly",
  owner: "U2",
  title: "Box only shortcut",
  covers: [],
  requires: [],
  chord: "Mod+Q",
  scope: "composer",
  allowInEditable: true,
  focus: "composer-input",
} as const satisfies ShortcutDescriptor & {
  readonly allowInEditable: true;
  readonly focus: "composer-input";
};

describe("a shortcut that runs only in the message box does not clash with a global shortcut that never runs there", () => {
  test("the composer's history search can take the chord of a global shortcut that works outside text boxes only", () => {
    const registry = registryOf([copyFromChat, composerHistory]);

    expect(registry.rebind("U2.historySearch", "Alt+C").ok).toBe(true);
  });

  test("the same chord is refused when the global shortcut also works in the message box", () => {
    const registry = registryOf([copyEverywhere, composerHistory]);
    const result = registry.rebind("U2.historySearch", "Alt+C");

    expect(result.ok).toBe(false);
    expect(result.conflicts[0]).toMatchObject({
      first: { id: "D4.copyEverywhere" },
      second: { id: "U2.historySearch" },
    });
  });

  test("two shortcuts limited to two different elements never meet, even on one chord", () => {
    expect(registryOf([sessionRename, boxOnly]).conflicts()).toEqual([]);
  });
});
