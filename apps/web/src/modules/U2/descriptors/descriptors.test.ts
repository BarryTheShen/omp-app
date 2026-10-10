import { Descriptor } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { U2Descriptors } from "./descriptors";

const EXPECTED_COVERAGE = [
  "F5.history-search",
  "F5.history-search-picker",
  "F5.external-editor",
  "F5.history-navigation",
  "F5.image-paste-and-image-chips",
  "F5.large-text-paste-handling",
  "F5.prompt-editor-core",
  "F5.app-clipboard-copyline",
  "F5.app-clipboard-copyprompt",
  "F5.app-clipboard-pasteimage",
  "F5.app-clipboard-pastetextraw",
  "F5.app-history-search",
  "F5.tui-editor-cursordown",
  "F5.tui-editor-cursorleft",
  "F5.tui-editor-cursorlineend",
  "F5.tui-editor-cursorlinestart",
  "F5.tui-editor-cursorright",
  "F5.tui-editor-cursorup",
  "F5.tui-editor-cursorwordleft",
  "F5.tui-editor-cursorwordright",
  "F5.tui-editor-deletecharbackward",
  "F5.tui-editor-deletecharforward",
  "F5.tui-editor-deletetolineend",
  "F5.tui-editor-deletetolinestart",
  "F5.tui-editor-deletewordbackward",
  "F5.tui-editor-deletewordforward",
  "F5.tui-editor-jumpbackward",
  "F5.tui-editor-jumpforward",
  "F5.tui-editor-pagedown",
  "F5.tui-editor-pageup",
  "F5.tui-editor-undo",
  "F5.tui-editor-yank",
  "F5.tui-editor-yankpop",
  "F5.tui-input-copy",
  "F5.tui-input-newline",
  "F5.tui-input-submit",
  "F5.tui-input-tab",
  "C6.python-composer-mode",
  "C6.bash-composer-mode",
  "C6.user-python-execution",
  "C6.user-bash-execution",
] as const;

describe("U2.1 descriptor coverage", () => {
  test("covers every U2-owned F5/C6 row exactly once", () => {
    const covered = U2Descriptors.flatMap((descriptor) => descriptor.covers);
    // The 41 row descriptors, plus the Alt+Shift+V alias: omp's second chord for paste as text, which covers no row.
    expect(U2Descriptors).toHaveLength(42);
    expect(covered).toHaveLength(EXPECTED_COVERAGE.length);
    expect(new Set(covered).size).toBe(EXPECTED_COVERAGE.length);
    expect([...covered].sort()).toEqual([...EXPECTED_COVERAGE].sort());
  });

  test("binds the clipboard rows to omp's chords, reachable from the editor", () => {
    expect(U2Descriptors.find((d) => d.id === "U2.clipboardCopyLine")).toMatchObject({
      chord: "Alt+Shift+L",
      scope: "global",
      allowInEditable: true,
    });
    expect(U2Descriptors.find((d) => d.id === "U2.clipboardCopyPrompt")).toMatchObject({
      chord: "Alt+Shift+C",
      scope: "global",
      allowInEditable: true,
    });
    expect(U2Descriptors.find((d) => d.id === "U2.clipboardPasteTextRaw")).toMatchObject({
      chord: "Mod+Shift+V",
      scope: "global",
      allowInEditable: true,
    });
    expect(U2Descriptors.find((d) => d.id === "U2.clipboardPasteTextRawAlt")).toMatchObject({
      chord: "Alt+Shift+V",
      covers: [],
      allowInEditable: true,
    });
  });

  test("validates the complete descriptor list through the C0 schema", () => {
    expect(() => Descriptor.array().parse(U2Descriptors)).not.toThrow();
  });

  test("requires Python capability and released Bash capability", () => {
    expect(
      U2Descriptors.find((descriptor) => descriptor.covers.includes("C6.python-composer-mode")),
    ).toMatchObject({
      requires: ["upstream.python-mode"],
    });
    expect(
      U2Descriptors.find((descriptor) => descriptor.covers.includes("C6.bash-composer-mode")),
    ).toMatchObject({
      requires: ["omp.cmd.bash"],
    });
  });
});
