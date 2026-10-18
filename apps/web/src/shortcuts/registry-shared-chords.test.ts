import type { Descriptor, ShortcutDescriptor } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
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

// The composer's arrow, declared as the app declares U2.cursorLeft: it runs only in the message box.
const composerLeft = {
  kind: "shortcut",
  id: "U2.cursorLeft",
  owner: "U2",
  title: "Move cursor left",
  covers: [],
  requires: [],
  chord: "ArrowLeft",
  scope: "composer",
  allowInEditable: true,
  focus: "composer-input",
} as const satisfies ShortcutDescriptor & {
  readonly allowInEditable: true;
  readonly focus: "composer-input";
};

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

  test("the message box's arrow and a tree's arrow can share a chord, since the message box's arrow runs only there", () => {
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

// A transcript shortcut on the arrow key that the tree uses, both working outside text boxes.
const transcriptLeft = {
  kind: "shortcut",
  id: "U1.transcriptLeft",
  owner: "U1",
  title: "Move left in the transcript",
  covers: [],
  requires: [],
  chord: "ArrowLeft",
  scope: "transcript",
} as const satisfies ShortcutDescriptor;

describe("two areas that both run outside text boxes cannot share a chord", () => {
  test("Delete session cannot be rebound onto Alt+T, and the refusal names Toggle thinking", () => {
    const result = registryOf(DESCRIPTORS).rebind("R1.sessionDelete", "Alt+T");

    expect(result.ok).toBe(false);
    const [clash] = result.conflicts;
    // The registry lists the pair in list order, so the check does not depend on which side comes first.
    expect([clash?.first.id, clash?.second.id].sort()).toEqual([
      "R1.sessionDelete",
      "U1.thinking.toggle",
    ]);
    expect([clash?.first.title, clash?.second.title]).toContain("Toggle thinking");
  });

  test("a tree shortcut and a transcript shortcut on one chord conflict, since each runs outside text boxes", () => {
    expect(registryOf([treeFold, transcriptLeft]).conflicts()).toHaveLength(1);
  });
});

describe("the composed tree and composer shortcuts use their own focus scopes", () => {
  test("the tree chord runs only in the tree, and the composer chord runs only in the message box", () => {
    const registry = registryOf(DESCRIPTORS);
    const treeAction = vi.fn();
    const composerAction = vi.fn();
    registry.registerAction("P4.treeFoldOrUpCtrl", treeAction);
    registry.registerAction("U2.cursorWordLeft", composerAction);
    const tree = document.createElement("div");
    tree.dataset.focusScope = "tree";
    const row = document.createElement("div");
    tree.append(row);
    const composer = document.createElement("div");
    composer.dataset.focusScope = "composer-input";
    document.body.append(tree, composer);

    const treeChordInTree = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    row.dispatchEvent(treeChordInTree);
    expect(registry.dispatch(treeChordInTree, "tree").handled).toBe(true);
    expect(treeAction).toHaveBeenCalledOnce();

    for (const modifiers of [{ metaKey: true }, { ctrlKey: true, metaKey: true }]) {
      const nonLiteralCtrl = new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      row.dispatchEvent(nonLiteralCtrl);
      expect(registry.dispatch(nonLiteralCtrl, "tree").handled).toBe(false);
    }
    expect(treeAction).toHaveBeenCalledOnce();

    const composerChordInTree = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      ctrlKey: true,
      cancelable: true,
    });
    row.dispatchEvent(composerChordInTree);
    expect(registry.dispatch(composerChordInTree, "composer").handled).toBe(false);
    expect(composerAction).not.toHaveBeenCalled();

    const treeChordInComposer = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    composer.dispatchEvent(treeChordInComposer);
    expect(registry.dispatch(treeChordInComposer, "tree").handled).toBe(false);
    expect(treeAction).toHaveBeenCalledOnce();

    const composerChordInComposer = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    composer.dispatchEvent(composerChordInComposer);
    expect(registry.dispatch(composerChordInComposer, "composer").handled).toBe(true);
    expect(composerAction).toHaveBeenCalledOnce();
    tree.remove();
    composer.remove();
  });
});
