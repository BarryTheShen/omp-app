import { type Descriptor, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { DESCRIPTORS } from "@/registry";
import { U4Descriptors } from "./descriptors";
import * as descriptorsModule from "./index";

const EXPECTED_U4_ROWS = [
  "E2.set-ask-dialog",
  "E2.ask-tool-dialog",
  "E2.generic-hook-selector",
  "E2.hook-multiline-editor",
  "E2.hook-text-input",
  "E2.generic-extension-confirmation",
  "E2.ask",
  "E2.extension-ui-cancellation",
  "E2.extension-confirm-dialog",
  "E2.extension-multiline-editor-dialog",
  "E2.extension-select-dialog",
  "E2.extension-single-line-input-dialog",
  "A1.report-tool-issue-consent",
  "A1.tool-approval-policy",
] as const;

describe("U4Descriptors", () => {
  test("covers exactly the 14 U4-owned inventory rows once", () => {
    const covered = U4Descriptors.flatMap((descriptor) => descriptor.covers);
    expect(covered).toHaveLength(EXPECTED_U4_ROWS.length);
    expect([...covered].sort()).toEqual([...EXPECTED_U4_ROWS].sort());
    expect(new Set(covered).size).toBe(EXPECTED_U4_ROWS.length);
  });

  test("uses owner-prefixed ids and the correct descriptor kinds/capabilities", () => {
    expect(U4Descriptors.every((descriptor) => descriptor.owner === "U4")).toBe(true);
    expect(U4Descriptors.every((descriptor) => descriptor.id.startsWith("U4."))).toBe(true);
    expect(U4Descriptors.find((descriptor) => descriptor.id === "U4.setAskDialog")).toMatchObject({
      kind: "command",
      requires: ["omp.ui", "omp.cmd.set_ask_dialog"],
    });
    expect(U4Descriptors.find((descriptor) => descriptor.id === "U4.ask")).toMatchObject({
      kind: "tool",
      match: { by: "name", name: "ask" },
    });
    expect(U4Descriptors.filter((descriptor) => descriptor.kind === "notice")).toHaveLength(5);
    expect("RENDERERS" in descriptorsModule).toBe(false);
  });

  test("passes validateRegistry when composed with the descriptors already on main", () => {
    const problems = validateRegistry([...DESCRIPTORS, ...U4Descriptors]);
    expect(problems).toEqual([]);
  });

  test("does not claim downstream feature namespaces or export an empty renderer alias", () => {
    const downstreamPrefixes = ["D2.", "D3.", "D4.", "D5.", "P2.", "C3.", "C4.", "N1."];
    const claims = U4Descriptors.flatMap((descriptor) => descriptor.covers);
    expect(claims.some((id) => downstreamPrefixes.some((prefix) => id.startsWith(prefix)))).toBe(
      false,
    );
    expect("RENDERERS" in descriptorsModule).toBe(false);
  });
});

const _descriptorTypeCheck: readonly Descriptor[] = U4Descriptors;
void _descriptorTypeCheck;
